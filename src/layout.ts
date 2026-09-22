import type {
  FragmentBreak,
  LayoutOptions,
  LayoutResult,
  LineBox,
  LineResult,
  PageGeometry,
  SemanticDoc,
  TextMetrics,
} from './types.js'
import { breakLines } from './line-breaker.js'

// M2 SLICER VOCABULARY:
// - A block FRAGMENTS when a page break lands inside it (between its
//   lines).
// - "Orphan" = a block's first line alone at the bottom of a page.
// - "Widow"  = a block's last line alone at the top of the next page.
//
// M2 placement rules, evaluated per attempt on page p (cursor y, H =
// remaining height) for a block of L lines with k already placed
// (n = L - k remaining). `fits` is ALWAYS computed by walking the
// block's ACTUAL line heights — mixed font sizes mean mixed line
// heights; never assume uniform. The precomputed `cap` (how many of
// THIS block's lines a fresh page holds) is used ONLY for the R4
// exemption test and R-ATOMIC's n <= cap check — "fill fresh pages to
// cap" is a characterization, not the mechanism.
//
//   R0. Whole remainder fits H → place, done.
//   R1. fits == 0 → close page, re-enter fresh. Fires only when the
//       page has content (y > 0): closing a fresh page is a vacuous
//       move (R6 territory instead).
//   R2. ORPHAN: fits == 1 && n > 1 && widowControl (and y > 0) → the
//       block's START moves to the next page (R1-style). Applies to
//       tall blocks too: only the START moves; after re-entry it
//       fragments naturally under R4. Never leaves a lone first line
//       at a page bottom. The y > 0 guard is loop-freedom: moving off
//       a fresh page re-creates the same situation forever.
//   R-ATOMIC. k == 0 && flow.keepLines && n <= cap → move the whole
//       block to the next page (R1-style). Tall blocks fall through to
//       R4 — can't keep together what can't fit together.
//   R3. WIDOW: n - fits == 1 && fits > 1 && widowControl → break at
//       fits - 1; re-check R2 (inheriting its y > 0 guard). Applies to
//       tall blocks at their end edge. Under uniform line heights this
//       can only arise on a fresh page with n == cap + 1 exactly;
//       mixed heights can produce it mid-page too (a small preceding
//       line can leave fits == cap) — handled identically.
//   R4. EXEMPTION (L > cap): no keep-together attempts, no adjustment
//       of intermediate breaks — natural splits at the actual-height
//       fits. Boundary minimums (R2/R3) still apply at the block's
//       edges; they were already evaluated above.
//   R5. NATURAL SPLIT: place `fits` lines, emit FragmentBreak{blockId,
//       atLine: k + fits, pageIndex: p + 1}, continue on the next page.
//   R6. SAFETY: a fresh page always places at least one line even if
//       it overflows — never loop forever.
//
// Degenerate corner, pinned by tests/slicer.test.ts #12: at cap == 2
// both boundary minimums are unsatisfiable — the widow is fixed and
// the orphan deliberately sacrificed, because loop-freedom and
// determinism outrank a minimum that cannot be honored; the y > 0
// guard makes moving vacuous.
//
// M2: full recompute on every call (v1 is allowed to be slow).
// TODO(M3+): use previous for incremental invalidation. `previous` is
// a PERF HINT only: consulting it may never change the correct answer —
// only how fast we get there.

export function createLayoutEngine({ metrics }: { metrics: TextMetrics }): {
  layout(doc: SemanticDoc, opts: LayoutOptions, previous?: LayoutResult): LayoutResult
} {
  return {
    layout(doc, opts, _previous?: LayoutResult): LayoutResult {
      validateFlow(doc)

      const size = {
        x: 0,
        y: 0,
        width: opts.page.width,
        height: opts.page.height,
      }
      // M2: all pages share opts geometry. TODO(sections): per-section
      // page descriptors.
      const contentBox = {
        x: opts.margins.left,
        y: opts.margins.top,
        width: opts.page.width - opts.margins.left - opts.margins.right,
        height: opts.page.height - opts.margins.top - opts.margins.bottom,
      }
      const newPage = (index: number): PageGeometry => ({ index, size, contentBox })

      const pages: PageGeometry[] = [newPage(0)]
      const lines: LineBox[] = []
      const breaks: FragmentBreak[] = []
      let pageIndex = 0
      let y = 0

      for (const block of doc.blocks) {
        if (block.kind !== 'paragraph') continue // TODO(M3+): headings
        const results = breakLines(block.runs, metrics, contentBox.width, doc.baseStyle)
        const L = results.length
        const control =
          block.flow?.widowControl ?? opts.preventWidowsAndOrphans ?? true
        // How many of THIS block's lines a fresh page holds — only the
        // R4 exemption test and R-ATOMIC's n <= cap check consume it.
        const cap = countFitting(results, 0, contentBox.height)

        const place = (from: number, count: number): void => {
          for (let i = from; i < from + count; i++) {
            const result = results[i]
            lines.push({
              blockId: block.id,
              lineIndex: i,
              pageIndex,
              rect: { x: 0, y, width: result.width, height: result.height },
              baseline: result.baseline,
              rangeStart: result.start,
              rangeEnd: result.end,
              segments: result.segments,
            })
            y += result.height
          }
        }

        const closePage = (): void => {
          pageIndex += 1
          y = 0
          pages.push(newPage(pageIndex))
        }

        let k = 0
        while (k < L) {
          const n = L - k
          let fits = countFitting(results, k, contentBox.height - y)

          if (fits >= n) {
            place(k, n) // R0
            k = L
            continue
          }

          if (fits === 0) {
            if (y > 0) {
              closePage() // R1
              continue
            }
            fits = 1 // R6: a fresh page always places one line
          }

          if (control && y > 0 && fits === 1 && n > 1) {
            closePage() // R2 orphan: the block's start moves
            continue
          }

          if (k === 0 && block.flow?.keepLines === true && n <= cap) {
            closePage() // R-ATOMIC: keepLines moves the whole block
            continue
          }

          if (control && n - fits === 1 && fits > 1) {
            fits -= 1 // R3 widow
            if (fits === 1 && y > 0 && n > 1) {
              closePage() // re-check R2 (inherits its y > 0 guard)
              continue
            }
          }

          // R4 exemption / R5 natural split — `fits` already came from
          // the actual-height walk above.
          place(k, fits)
          k += fits
          if (k < L) {
            breaks.push({ blockId: block.id, atLine: k, pageIndex: pageIndex + 1 })
            closePage()
          }
        }
      }

      return { pages, lines, breaks, version: 1 }
    },
  }
}

// Greedy walk of ACTUAL line heights: how many lines starting at `from`
// fit within `height`. A line fits iff cumulative height stays within
// `height` — no epsilon.
function countFitting(results: readonly LineResult[], from: number, height: number): number {
  let used = 0
  let count = 0
  for (let i = from; i < results.length; i++) {
    const { height: lineHeight } = results[i]
    if (used + lineHeight > height) break
    used += lineHeight
    count++
  }
  return count
}

// M2.5 LOUD SEAMS: keepNext, keepPrevious, breakBefore, and breakAfter
// have no implemented semantics. Genuinely set values throw —
// unimplemented surface must be loud, never a silent no-op. null is
// treated as UNSET: PM attribute JSON round-trips use null for absent
// attrs, so a .tensor file with flow: { keepNext: null } must not
// throw on load. For booleans the === true check already treats null
// and false (the default semantics) as unset/harmless.
function validateFlow(doc: SemanticDoc): void {
  for (const block of doc.blocks) {
    const flow = block.flow
    if (!flow) continue
    if (flow.keepNext === true) {
      throw new Error('not yet implemented: flow.keepNext (M2.5)')
    }
    if (flow.keepPrevious === true) {
      throw new Error('not yet implemented: flow.keepPrevious (M2.5)')
    }
    if ((flow.breakBefore ?? undefined) !== undefined) {
      throw new Error('not yet implemented: flow.breakBefore (M2.5)')
    }
    if ((flow.breakAfter ?? undefined) !== undefined) {
      throw new Error('not yet implemented: flow.breakAfter (M2.5)')
    }
  }
}
