import type {
  Block,
  FragmentBreak,
  LayoutEngine,
  LayoutOptions,
  LayoutResult,
  LastStats,
  LineBox,
  LineResult,
  PageGeometry,
  ParagraphBlock,
  Rect,
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
// M3 INCREMENTAL WALK — PARITY LAW: the engine instance may memoize;
// warm output must deep-equal cold output — verified by
// tests/parity.fuzz.test.ts, forever. Same answers, provably; less
// work, measurably (engine.lastStats).
//
//  - MARKOV PROPERTY (the core proof): placement of blocks k..end is
//    fully determined by (state at k, blocks k..end, opts) — nothing
//    else persists across block boundaries. This is why splicing is
//    EXACT here, where the old DOM-based system could only fingerprint.
//  - Lemma 1: unchanged blocks + identical entry states ⇒ identical
//    outputs. Prefix blocks are reused directly; after each walked
//    block, splice consumes cached entries while (entry state AND id
//    AND contentHash) verify — trust is verified, never assumed. A
//    mid-splice mismatch aborts the splice and keeps walking (and
//    re-attempting) — that is how reconvergence splices happen.
//  - The caches live INSIDE the engine instance, NOT in LayoutResult.
//    M4 CONSEQUENCE: the shell must hold ONE stable engine instance;
//    new metrics requires a new engine.
//  - Stats hygiene: lastStats is rebuilt from scratch on every call —
//    never accumulated (a stale counter would make the scripted
//    "walked 1 / spliced 49" lie). cacheEpoch persists across calls
//    but resets to 0 in a fresh engine.
//  - IMMOVABILITY (enforced): emitted LineBox/FragmentBreak/PageGeometry
//    records are Object.freeze'd at creation — zero-copy sharing with
//    copying's safety at none of the cost.

// Walk state: (pageIndex, yCursor) at block entry. The unit of the
// Markov property — nothing else persists across block boundaries.
interface WalkState {
  pageIndex: number
  y: number
}

// Per-block walk cache, in doc order. The chain invariant holds by
// construction: entry[i+1] == exit[i] for consecutive entries.
interface WalkCacheEntry {
  blockId: string
  contentHash: string
  entryState: WalkState
  lineBoxes: LineBox[]
  breaks: FragmentBreak[]
  exitState: WalkState
}

// Line-level cache: a block's LineResults depend only on (runs,
// maxWidth, baseStyle) — keyed by the block id, re-validated by hash.
interface CachedLines {
  contentHash: string
  maxWidth: number
  lines: LineResult[]
}

/**
 * Creates a layout engine bound to the given metrics port. The cache
 * lives inside the returned instance — M4 CONSEQUENCE: the shell must
 * hold ONE stable engine instance (new metrics requires a new engine).
 */
export function createLayoutEngine({ metrics }: { metrics: TextMetrics }): LayoutEngine {
  const lineCache = new Map<string, CachedLines>()
  let walkCache: WalkCacheEntry[] = []
  let storedOptsHash: string | null = null
  let storedBaseStyleHash: string | null = null
  let cacheEpoch = 0
  let version = 1
  let hadCall = false
  let currentStats: LastStats = {
    blocksWalked: 0,
    linesRebroken: 0,
    blocksSpliced: 0,
    cacheEpoch: 0,
    invalidated: false,
  }

  return {
    layout(doc, opts) {
      // Loud seams, upfront — before any cache work.
      validateDuplicateIds(doc)
      validateFlow(doc)

      // Stats hygiene: rebuilt from scratch every call, never
      // accumulated — a stale counter would make the scripted counts lie.
      const stats: LastStats = {
        blocksWalked: 0,
        linesRebroken: 0,
        blocksSpliced: 0,
        cacheEpoch: 0,
        invalidated: false,
      }

      const size = Object.freeze({
        x: 0,
        y: 0,
        width: opts.page.width,
        height: opts.page.height,
      })
      // M2: all pages share opts geometry. TODO(sections): per-section
      // page descriptors.
      const contentBox: Rect = Object.freeze({
        x: opts.margins.left,
        y: opts.margins.top,
        width: opts.page.width - opts.margins.left - opts.margins.right,
        height: opts.page.height - opts.margins.top - opts.margins.bottom,
      })

      const hashes = doc.blocks.map(hashBlock)
      const optsHash = stableStringify(opts)
      const baseStyleHash = stableStringify(doc.baseStyle)

      // Context change (opts or baseStyle) drops both caches
      // wholesale. baseStyle feeds empty-line LineResults, so a stale
      // baseStyle would violate parity. The FIRST call is not
      // invalidation (no prior cache exists).
      const hadCache = storedOptsHash !== null
      const contextChanged =
        hadCache && (storedOptsHash !== optsHash || storedBaseStyleHash !== baseStyleHash)
      if (contextChanged) {
        lineCache.clear()
        walkCache = []
        cacheEpoch += 1
        stats.invalidated = true
      }
      storedOptsHash = optsHash
      storedBaseStyleHash = baseStyleHash
      stats.cacheEpoch = cacheEpoch

      const oldCache = walkCache

      // Resume = first index where [id, contentHash] differs. Length
      // mismatch counts as a difference at the shorter length's end.
      let resume = Math.min(doc.blocks.length, oldCache.length)
      for (let i = 0; i < resume; i++) {
        if (doc.blocks[i].id !== oldCache[i].blockId || hashes[i] !== oldCache[i].contentHash) {
          resume = i
          break
        }
      }

      const lines: LineBox[] = []
      const breaks: FragmentBreak[] = []
      const newCache: WalkCacheEntry[] = []

      // Lemma 1: unchanged blocks + identical entry states ⇒ identical
      // outputs — the prefix is reused directly.
      for (let i = 0; i < resume; i++) {
        lines.push(...oldCache[i].lineBoxes)
        breaks.push(...oldCache[i].breaks)
        newCache.push(oldCache[i])
      }
      let state: WalkState =
        resume > 0 ? oldCache[resume - 1].exitState : { pageIndex: 0, y: 0 }

      let i = resume
      while (i < doc.blocks.length) {
        const block = doc.blocks[i]
        const entryState = state

        if (block.kind !== 'paragraph') {
          // TODO(M4): headings emit no lines yet; when they do, E6
          // (heading entries in the walk cache) becomes load-bearing.
          newCache.push({
            blockId: block.id,
            contentHash: hashes[i],
            entryState,
            lineBoxes: [],
            breaks: [],
            exitState: entryState,
          })
          i += 1
          continue
        }

        // Line-level reuse: hash + maxWidth re-validated.
        const cached = lineCache.get(block.id)
        let results: LineResult[]
        if (cached && cached.contentHash === hashes[i] && cached.maxWidth === contentBox.width) {
          results = cached.lines
        } else {
          results = breakLines(block.runs, metrics, contentBox.width, doc.baseStyle)
          lineCache.set(block.id, {
            contentHash: hashes[i],
            maxWidth: contentBox.width,
            lines: results,
          })
          stats.linesRebroken += 1
        }

        const control = block.flow?.widowControl ?? opts.preventWidowsAndOrphans ?? true
        const placed = placeBlock(block, results, entryState, contentBox.height, control)
        stats.blocksWalked += 1
        lines.push(...placed.lineBoxes)
        breaks.push(...placed.breaks)
        newCache.push({
          blockId: block.id,
          contentHash: hashes[i],
          entryState,
          lineBoxes: placed.lineBoxes,
          breaks: placed.breaks,
          exitState: placed.exitState,
        })
        state = placed.exitState

        // SPLICE GATE. Consume cached entries while (entry state AND
        // id AND contentHash) verify. PROOF-PINNING: exact === on the
        // state floats is sound ONLY because warm and cold walks
        // execute the identical operation sequence (same y-cursor
        // additions, same order, same values); IEEE guarantees
        // bitwise-identical results. A refactor that reorders
        // accumulation breaks this proof silently — the parity fuzzer
        // is the tripwire. A gate FAILING on reordered accumulation is
        // merely a missed splice (safe); a gate passing on unequal
        // states is impossible under ===.
        let j = i + 1
        while (
          j < doc.blocks.length &&
          j < oldCache.length &&
          sameState(state, oldCache[j].entryState) &&
          doc.blocks[j].id === oldCache[j].blockId &&
          hashes[j] === oldCache[j].contentHash
        ) {
          lines.push(...oldCache[j].lineBoxes)
          breaks.push(...oldCache[j].breaks)
          newCache.push(oldCache[j])
          state = oldCache[j].exitState
          stats.blocksSpliced += 1
          j += 1
        }
        i = j
      }

      walkCache = newCache

      // Pages derived: every opened page holds >= 1 line (M2
      // invariant), so this equals the M2 closePage count exactly.
      // Empty doc → 1 page.
      let maxPage = 0
      for (const line of lines) if (line.pageIndex > maxPage) maxPage = line.pageIndex
      for (const brk of breaks) if (brk.pageIndex > maxPage) maxPage = brk.pageIndex
      const pages: PageGeometry[] = []
      for (let p = 0; p <= maxPage; p++) {
        pages.push(Object.freeze({ index: p, size, contentBox }))
      }

      const didWork =
        stats.blocksWalked > 0 || stats.linesRebroken > 0 || stats.invalidated
      if (didWork && hadCall) {
        version += 1
      }
      hadCall = true

      currentStats = Object.freeze(stats)
      return { pages, lines, breaks, version }
    },

    get lastStats(): LastStats {
      return currentStats
    },
  }
}

// The M2 placement machine. PURE: a function of (block, LineResults,
// entry state, content-box height, widow control) — the Markov property
// made physically true of the code.
function placeBlock(
  block: ParagraphBlock,
  results: readonly LineResult[],
  entryState: WalkState,
  contentHeight: number,
  control: boolean,
): { lineBoxes: LineBox[]; breaks: FragmentBreak[]; exitState: WalkState } {
  const L = results.length
  // How many of THIS block's lines a fresh page holds — only the R4
  // exemption test and R-ATOMIC's n <= cap check consume it.
  const cap = countFitting(results, 0, contentHeight)
  const lineBoxes: LineBox[] = []
  const breaks: FragmentBreak[] = []
  let { pageIndex, y } = entryState

  const place = (from: number, count: number): void => {
    for (let i = from; i < from + count; i++) {
      const result = results[i]
      lineBoxes.push(
        freezeLineBox({
          blockId: block.id,
          lineIndex: i,
          pageIndex,
          rect: { x: 0, y, width: result.width, height: result.height },
          baseline: result.baseline,
          rangeStart: result.start,
          rangeEnd: result.end,
          segments: result.segments,
        }),
      )
      y += result.height
    }
  }

  const closePage = (): void => {
    pageIndex += 1
    y = 0
  }

  let k = 0
  while (k < L) {
    const n = L - k
    let fits = countFitting(results, k, contentHeight - y)

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

    // R4 exemption / R5 natural split — `fits` already came from the
    // actual-height walk above.
    place(k, fits)
    k += fits
    if (k < L) {
      breaks.push(Object.freeze({ blockId: block.id, atLine: k, pageIndex: pageIndex + 1 }))
      closePage()
    }
  }

  return { lineBoxes, breaks, exitState: { pageIndex, y } }
}

// Enforced immutability at creation: freeze the record, its rect, and
// its segments (leaf records — idempotent, one-time cost).
function freezeLineBox(box: LineBox): LineBox {
  Object.freeze(box.rect)
  for (const segment of box.segments) Object.freeze(segment)
  Object.freeze(box.segments)
  return Object.freeze(box)
}

function sameState(a: WalkState, b: WalkState): boolean {
  return a.pageIndex === b.pageIndex && a.y === b.y
}

// contentHash covers everything that determines a block's lines and
// placement: kind (paragraph lines up, headings do not), runs
// (text + style), and flow (keepLines/widowControl move the rules).
// An id is NOT part of the hash — it is compared separately.
function hashBlock(block: Block): string {
  return stableStringify({
    kind: block.kind,
    runs: block.runs.map((run) => ({ text: run.text, style: run.style })),
    flow: block.flow,
  })
}

// Hand-rolled stable stringify: object keys sorted, undefined-valued
// keys dropped (so {bold: undefined} ≡ {}). No new deps.
function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
      .filter((key) => obj[key] !== undefined)
      .sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`
  }
  return '"unsupported"'
}

// Duplicate ids are an adapter-contract violation, loud and upfront —
// before any cache work. Also protects the id-keyed lineCache and the
// splice id-verification from ambiguity.
function validateDuplicateIds(doc: SemanticDoc): void {
  const seen = new Set<string>()
  for (const block of doc.blocks) {
    if (seen.has(block.id)) {
      throw new Error(`duplicate block id: ${block.id}`)
    }
    seen.add(block.id)
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
