import type {
  Block,
  FragmentBreak,
  LayoutEngine,
  LayoutOptions,
  LastStats,
  LineBox,
  LineResult,
  PageGeometry,
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
//    counts lie). cacheEpoch persists across calls but resets to 0 in
//    a fresh engine.
//  - IMMOVABILITY (enforced): emitted LineBox/FragmentBreak/PageGeometry
//    records are Object.freeze'd at creation — zero-copy sharing with
//    copying's safety at none of the cost.
//
// M2.5 FLOW POLICY — the last loud seams close. Word-exact boundary
// bonds, forced page breaks, real heading layout (headings route
// through breakLines exactly like paragraphs; TODO(M4): level-based
// default styles arrive from the ADAPTER — level is not a layout
// input here).
//
//  - BOND(A→B) ⇔ A's last line and B's first line share a page. One
//    mechanism, two spellings: flow.keepNext on A or flow.keepPrevious
//    on B; null counts as UNSET at every use site (PM attribute JSON
//    round-trips use null for absent attrs). Detection happens at A's
//    placement via a LOOKAHEAD of B's first-line height (firstLineLands
//    below — the exact same rules the walk applies), fetched from
//    lineCache/breakLines on demand (the cache absorbs it).
//  - ENFORCEMENT SHAPES (bounded: ONE attempt per bond per call; the
//    R6 floor stands):
//      violated + A fits a fresh page + A entered mid-page (y > 0) →
//        move A's start (R1 shape).
//      A tall → back A's FINAL split point up one line, floor 1 line
//        (R3 shape) — A's last line joins B's page.
//      Vacuous move (A already starts a fresh page), floor hit, or
//        still violated after the attempt → the bond DROPS. A stays at
//        the moved page per the (f) ruling — no revert; the move was
//        unproductive but deterministic.
//  - SHAPE-1 MOVES CASCADE BACKWARD: moving B for bond(B→C)
//    retro-violates bond(A→B) → A enforces in turn, re-flowing the
//    chain. Cascade floor: the head already starts a fresh page →
//    drop the EARLIEST bond — honor the maximal SUFFIX (drop earliest
//    first). "Tensor's pinned choice — Word's exact tie-break here is
//    undocumented; this is our spec of record."
//  - PRECEDENCE (pinned): structural forced breaks > orphan move (R2)
//    > bond > widow adjust (R3), applied as a bounded re-check loop
//    (each adjustment re-runs the checks; terminates via R6).
//    R-ATOMIC sits with orphan in tier 2 (a successor start-move); the
//    bond then cascades the predecessor, bounded. Bond preempts R3:
//    when the bond already relocates A's last line onto B's page, the
//    widow concern is void — a STRUCTURALLY DROPPED bond does NOT
//    preempt (control returns to R3; pinned by flow.test.ts).
//  - STRUCTURAL DROP: a bond at a boundary carrying a forced break —
//    breakBefore(B) OR breakAfter(A), symmetric, both spellings —
//    drops at detection, loudly: a page that must start with B cannot
//    also start with A's last fragment.
//  - FORCED BREAKS: breakBefore closes a non-fresh page before the
//    block (fresh start = no-op); breakAfter closes after the block.
//    A closed page always holds content — never an empty page; a
//    trailing close never materializes (pages derive from the max line
//    pageIndex). Forced breaks emit NO FragmentBreak (not mid-block
//    splits).
//  - CACHE: the resume point extends BACKWARD through bonded chains —
//    a bonded predecessor's placement consumed its successor's
//    first-line height, so an edit inside the successor can invalidate
//    the predecessor's cached placement; blocksWalked counts the
//    re-walked bonded predecessors. Splices never cross a
//    breakBefore(B) boundary (the gate's state equality fails; the
//    walk re-applies the close) — conservative, safe.

// Walk state: (pageIndex, yCursor) at block entry. The unit of the
// Markov property — nothing else persists across block boundaries.
interface WalkState {
  pageIndex: number
  y: number
}

// Per-block walk cache, in doc order. exit[i] is the MACHINE exit;
// entry[i+1] = exit[i] plus the walk's cursor transforms (a breakAfter
// close on i, and/or a breakBefore close on i+1). Every path that
// resumes the cursor from a cached exit re-applies those closes via
// cursorAfter. Splice gates compare transformed cursors, so a
// breakBefore(B) boundary fails the gate safely (the walk re-applies
// the close) while breakAfter boundaries splice through.
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
      // Loud adapter contract, upfront — before any cache work.
      validateDuplicateIds(doc)

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

      // M2.5 BACKWARD-RESUME through bonded chains: a bonded
      // predecessor's placement consumed its successor's first-line
      // height (the bond lookahead), so an edit inside the successor
      // can invalidate the predecessor's cached placement — extend the
      // resume point BACKWARD while blocks[resume-1] bonds to
      // blocks[resume]. Flag-level (conservative: a structurally
      // dropped bond still extends — a spurious extension only
      // re-walks, never mis-splices). blocksWalked counts the re-walked
      // bonded predecessors.
      while (resume > 0 && bondExistsBetween(doc, resume - 1)) {
        resume -= 1
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

      // The walk state entering block `resume`, reconstructed from the
      // prefix: the predecessor's machine exit plus its breakAfter
      // close (a cursor transform).
      const startState: WalkState = (() => {
        if (resume === 0) return { pageIndex: 0, y: 0 }
        return cursorAfter(doc.blocks[resume - 1], oldCache[resume - 1].exitState)
      })()

      const walked = new Set<number>()
      // Bounded enforcement: one attempt per bond (keyed by the
      // predecessor's index) per call.
      const bondAttempts = new Set<number>()

      const getLines = (index: number): LineResult[] => {
        const block = doc.blocks[index]
        const cached = lineCache.get(block.id)
        const hash = hashes[index]
        if (cached && cached.contentHash === hash && cached.maxWidth === contentBox.width) {
          return cached.lines
        }
        const results = breakLines(block.runs, metrics, contentBox.width, doc.baseStyle)
        lineCache.set(block.id, {
          contentHash: hash,
          maxWidth: contentBox.width,
          lines: results,
        })
        stats.linesRebroken += 1
        return results
      }

      const controlOf = (block: Block): boolean =>
        block.flow?.widowControl ?? opts.preventWidowsAndOrphans ?? true

      // Truncate the walk to index i (popping re-placed blocks' outputs)
      // and commit the entry — cascade unwinds go through here.
      const commit = (index: number, entry: WalkCacheEntry): void => {
        while (newCache.length > index) {
          const popped = newCache.pop()!
          lines.length -= popped.lineBoxes.length
          breaks.length -= popped.breaks.length
        }
        newCache.push(entry)
        lines.push(...entry.lineBoxes)
        breaks.push(...entry.breaks)
      }

      let state: WalkState = startState
      let i = resume
      while (i < doc.blocks.length) {
        const block = doc.blocks[i]

        // STRUCTURAL TIER (precedence 1): breakBefore closes a
        // non-fresh page; a fresh-page start is a no-op. Emits no
        // FragmentBreak (not a mid-block split).
        if (block.flow?.breakBefore === 'page' && state.y > 0) {
          state = { pageIndex: state.pageIndex + 1, y: 0 }
        }

        // M2.5: headings route through breakLines exactly like
        // paragraphs — E6 (heading entries in the walk cache) became
        // load-bearing. TODO(M4): level-based default styles arrive
        // from the ADAPTER; level is not a layout input here.
        const entryState = state
        const results = getLines(i)
        const control = controlOf(block)
        const next = doc.blocks[i + 1]
        const bondExists =
          next !== undefined &&
          (block.flow?.keepNext === true || next.flow?.keepPrevious === true)
        const structural =
          bondExists &&
          (block.flow?.breakAfter === 'page' || next.flow?.breakBefore === 'page')
        const bonded = bondExists && !structural

        let currentEntry = entryState
        let placed = placeBlock(
          block, results, currentEntry, contentBox.height, control, bonded, false,
        )
        let movedViaShape1 = false

        if (structural) {
          // STRUCTURAL DROP (loud): breakBefore(B) or breakAfter(A) —
          // both spellings, symmetric — puts a forced break at the A→B
          // boundary. A page that must start with B cannot also start
          // with A's last fragment; the bond drops at detection, no
          // enforcement attempt. The drop does NOT preempt R3 (bonded
          // is false above): control returns to the widow rule —
          // pinned by the composed flow test (6/2, never 7/1).
        } else if (bonded) {
          // BOND LOOKAHEAD — A's placement consumes B's first-line
          // height via firstLineLands, the exact same rules the walk
          // applies (see its comment for the full arm list).
          const nextLines = getLines(i + 1)
          if (
            !firstLineLands(next, nextLines, placed.exitState, contentBox.height, controlOf(next))
          ) {
            if (!bondAttempts.has(i)) {
              bondAttempts.add(i)
              const fitsFresh =
                countFitting(results, 0, contentBox.height) === results.length
              if (fitsFresh && entryState.y > 0) {
                // SHAPE 1 (R1 shape): move A's start to the fresh page.
                currentEntry = { pageIndex: entryState.pageIndex + 1, y: 0 }
                placed = placeBlock(
                  block, results, currentEntry, contentBox.height, control, bonded, false,
                )
                movedViaShape1 = true
                // Still violated → bounded drop. A stays at the moved
                // page per the (f) ruling — no revert; the move was
                // unproductive but deterministic.
              } else if (!fitsFresh) {
                // SHAPE 2 (R3 shape): A tall → back the FINAL split
                // point up one line; A's last line joins B's page.
                // Floor: a single-line final fragment cannot back up
                // (placeBlock places it naturally) → bounded drop.
                placed = placeBlock(
                  block, results, currentEntry, contentBox.height, control, bonded, true,
                )
              }
              // else: fitsFresh && entryState.y === 0 → VACUOUS
              // (impossible-after-move family): A already starts a
              // fresh page; moving re-creates the same situation
              // forever → the bond drops.
            }
            // else: the attempt was already used this call → bounded
            // drop (pinned by the composed R2-re-fire flow test).
          }
        }

        commit(i, {
          blockId: block.id,
          contentHash: hashes[i],
          entryState: currentEntry,
          lineBoxes: placed.lineBoxes,
          breaks: placed.breaks,
          exitState: placed.exitState,
        })
        if (!walked.has(i)) {
          walked.add(i)
          stats.blocksWalked += 1
        }
        state = placed.exitState

        // STRUCTURAL: breakAfter closes the page after the block — the
        // closed page always holds this block's lines, never an empty
        // page; a trailing close never materializes a phantom page
        // (pages derive from the max line pageIndex). Emits no
        // FragmentBreak.
        if (block.flow?.breakAfter === 'page') {
          state = { pageIndex: state.pageIndex + 1, y: 0 }
        }

        // BACKWARD CASCADE (shape-1 moves only — shape 2 moves no
        // start): moving B for bond(B→C) retro-violates bond(A→B); the
        // predecessor enforces in turn. Bounded: one attempt per bond;
        // the chain re-flows from the unwind point.
        if (movedViaShape1 && i > resume) {
          const prev = doc.blocks[i - 1]
          const prevEntry = newCache[i - 1]
          const prevBondActive =
            (prev.flow?.keepNext === true || block.flow?.keepPrevious === true) &&
            prev.flow?.breakAfter !== 'page' &&
            block.flow?.breakBefore !== 'page'
          if (
            prevBondActive &&
            placed.lineBoxes[0].pageIndex !==
              prevEntry.lineBoxes[prevEntry.lineBoxes.length - 1].pageIndex
          ) {
            // bond (i-1 → i) violated → predecessor enforcement (one
            // attempt, keyed i-1).
            if (!bondAttempts.has(i - 1)) {
              const prevResults = getLines(i - 1)
              const prevFitsFresh =
                countFitting(prevResults, 0, contentBox.height) === prevResults.length
              const prevEntryState = prevEntry.entryState
              if (prevFitsFresh && prevEntryState.y > 0) {
                bondAttempts.add(i - 1)
                // Unwind: close the predecessor's entry page, re-place
                // it fresh; the loop re-flows the chain from there.
                i -= 1
                state = { pageIndex: prevEntryState.pageIndex + 1, y: 0 }
                continue
              }
              if (!prevFitsFresh) {
                // Predecessor tall → SHAPE 2 in place: its final split
                // backs up one line to join block i's fresh page. No
                // start moved → no further cascade.
                bondAttempts.add(i - 1)
                const prevPlaced = placeBlock(
                  prev,
                  prevResults,
                  prevEntryState,
                  contentBox.height,
                  controlOf(prev),
                  true,
                  true,
                )
                commit(i - 1, {
                  blockId: prev.id,
                  contentHash: hashes[i - 1],
                  entryState: prevEntryState,
                  lineBoxes: prevPlaced.lineBoxes,
                  breaks: prevPlaced.breaks,
                  exitState: prevPlaced.exitState,
                })
                state = prevPlaced.exitState
                continue // the loop re-places block i from the new state
              }
              // else: the predecessor already starts a fresh page —
              // vacuous. Drop the EARLIEST bond (maximal-suffix
              // give-up); block i stays at its moved position.
            }
            // else: bounded drop (attempt used).
          }
        }

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
        const preSpliceState = state
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
          // CURSOR RECONSTRUCTION: the cached exitState is the MACHINE
          // exit — a breakAfter close is a cursor transform applied by
          // the walk AFTER placement, not part of the record. Every
          // path that resumes the cursor from a cached exit must
          // re-apply the close, or the next block enters a stale
          // mid-page state.
          state = cursorAfter(doc.blocks[j], oldCache[j].exitState)
          stats.blocksSpliced += 1
          j += 1
        }
        // The splice may not END on a bonded predecessor: its cached
        // placement consumed its successor's first-line height (the
        // bond lookahead), and the successor was NOT spliced — it
        // changed (or ended the run), so that context is stale. Un-
        // consume trailing bonded entries; the walk re-places them
        // with a fresh lookahead. Symmetric with the backward-resume
        // rule at the prefix boundary.
        while (j - 1 > i && bondExistsBetween(doc, j - 1)) {
          const popped = newCache.pop()!
          lines.length -= popped.lineBoxes.length
          breaks.length -= popped.breaks.length
          stats.blocksSpliced -= 1
          j -= 1
        }
        if (j > i + 1) {
          // Remaining consumed entries chain exactly to the current
          // cursor (breakAfter closes re-applied).
          state = cursorAfter(doc.blocks[j - 1], newCache[newCache.length - 1].exitState)
        } else {
          // Nothing consumed (or all un-consumed): restore the
          // pre-splice cursor (includes a possible breakAfter close —
          // not recoverable from newCache's machine exits).
          state = preSpliceState
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

// BOND LOOKAHEAD — predicts whether a block's FIRST line lands on the
// entry page, mirroring the placement machine's start decisions
// EXACTLY. The prediction must mirror "the same rules the walk
// applies" completely, or it isn't exact; every arm is listed:
//   - structural breakBefore: y > 0 → the page closes → next page.
//   - R0: the whole block fits → stays.
//   - fits == 0: y > 0 → R1 closes → next page; y == 0 → R6 places
//     the first line by fiat on the entry page → STAYS (degenerate: a
//     single line taller than the page still lands on the entry page —
//     the bond HOLDS).
//   - R2 orphan: fits == 1 && n > 1 && control && y > 0 → next page.
//   - R-ATOMIC: keepLines && n <= cap while the block doesn't fit →
//     next page (cannot fire at y == 0: n <= cap means a fresh page
//     fits the whole block, so R0 already fired).
//   - otherwise: R3-adjusted/R5 splits place fits >= 1 FIRST lines on
//     the entry page → stays (R3 never moves the start).
function firstLineLands(
  block: Block,
  lines: readonly LineResult[],
  entry: WalkState,
  contentHeight: number,
  control: boolean,
): boolean {
  if (block.flow?.breakBefore === 'page' && entry.y > 0) return false
  const n = lines.length
  const fits = countFitting(lines, 0, contentHeight - entry.y)
  if (fits >= n) return true
  if (fits === 0) return entry.y === 0
  if (fits === 1 && n > 1 && control && entry.y > 0) return false
  const cap = countFitting(lines, 0, contentHeight)
  if (block.flow?.keepLines === true && n <= cap) return false
  return true
}

// Cursor reconstruction: the walk applies a block's breakAfter close
// AFTER placement as a cursor transform — the cached exitState is the
// MACHINE exit. Every path that resumes the cursor from a cached exit
// must re-apply the close, or the next block enters a stale mid-page
// state (a parity bug the fuzzer caught).
function cursorAfter(block: Block, exit: WalkState): WalkState {
  if (block.flow?.breakAfter === 'page') {
    return { pageIndex: exit.pageIndex + 1, y: 0 }
  }
  return exit
}

// Bond flags between blocks[i] and blocks[i+1] (either spelling).
function bondExistsBetween(doc: SemanticDoc, i: number): boolean {
  const a = doc.blocks[i]
  const b = doc.blocks[i + 1]
  if (a === undefined || b === undefined) return false
  return a.flow?.keepNext === true || b.flow?.keepPrevious === true
}

// The M2 placement machine. PURE: a function of (block, LineResults,
// entry state, content-box height, widow control, bond context, split
// backup) — the Markov property made physically true of the code.
// `bonded` (an ACTIVE bond to the successor) preempts R3: when the
// bond already relocates A's last line onto B's page, the widow
// concern is void. `backupFinalSplit` is the one-shot shape-2 hook:
// the FINAL fragment places one line fewer, so A's last line opens
// the successor's page.
function placeBlock(
  block: Block,
  results: readonly LineResult[],
  entryState: WalkState,
  contentHeight: number,
  control: boolean,
  bonded: boolean,
  backupFinalSplit: boolean,
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
      if (backupFinalSplit && n > 1) {
        // SHAPE 2 (R3 shape): back the FINAL split point up one line —
        // A's last line opens the successor's page.
        place(k, n - 1)
        k += n - 1
        breaks.push(Object.freeze({ blockId: block.id, atLine: k, pageIndex: pageIndex + 1 }))
        closePage()
        continue
      }
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

    if (control && !bonded && n - fits === 1 && fits > 1) {
      fits -= 1 // R3 widow (bond preempts when ACTIVE)
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
// placement: kind (both kinds line up since M2.5), runs (text +
// style), and flow (keepLines/widowControl/bonds/forced breaks). An
// id is NOT part of the hash — it is compared separately.
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
