import type {
  Block,
  FragmentBreak,
  ImageBlock,
  LayoutEngine,
  LastStats,
  LineBox,
  LineResult,
  PageGeometry,
  PlacedRect,
  Rect,
  SemanticDoc,
  TextMetrics,
} from './types.js'
import { breakCodeLines, breakLines, fitDownImage } from './line-breaker.js'

// SLICER VOCABULARY:
// - A block FRAGMENTS when a page break lands inside it (between its
//   lines).
// - "Orphan" = a block's first line alone at the bottom of a page.
// - "Widow"  = a block's last line alone at the top of the next page.
//
// BLOCK-TIER SPACING (spaceBefore/spaceAfter): spaceBefore is
// applied ONCE at block entry — fit counts evaluate against the line
// tops, and the y > 0 loop-freedom guards test line-top presence
// (spaceBefore is not content). spaceAfter joins the block's EXIT
// cursor, so the next block's fits account for it. Fragment
// continuations never re-apply spaceBefore: it was consumed at entry,
// and closePage resets the cursor to a bare page top.
//
// Placement rules, evaluated per attempt on page p (cursor y, H =
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
//       page holds line tops (hasContent): closing a fresh page is a
//       vacuous move (R6 territory instead). spaceBefore pads the
//       cursor but is NOT content — a page holding only spaceBefore
//       is still fresh.
//   R2. ORPHAN: fits == 1 && n > 1 && widowControl (and hasContent) → the
//       block's START moves to the next page (R1-style). Applies to
//       tall blocks too: only the START moves; after re-entry it
//       fragments naturally under R4. Never leaves a lone first line
//       at a page bottom. The y > 0 guard is loop-freedom: moving off
//       a fresh page re-creates the same situation forever.
//   R-ATOMIC. k == 0 && flow.keepLines && n <= cap && hasContent →
//       move the whole block to the next page (R1-style). Tall blocks
//       fall through to R4 — can't keep together what can't fit
//       together.
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
// INCREMENTAL WALK — PARITY LAW: the engine instance may memoize;
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
//    CONSEQUENCE FOR CONSUMERS: the shell must hold ONE stable
//    engine instance; new metrics requires a new engine.
//  - Stats hygiene: lastStats is rebuilt from scratch on every call —
//    never accumulated (a stale counter would make the scripted
//    counts lie). cacheEpoch persists across calls but resets to 0 in
//    a fresh engine.
//  - IMMOVABILITY (enforced): emitted LineBox/FragmentBreak/PageGeometry
//    records are Object.freeze'd at creation — zero-copy sharing with
//    copying's safety at none of the cost.
//
// FLOW POLICY: Word-exact boundary
// bonds, forced page breaks, real heading layout (headings route
// through breakLines exactly like paragraphs; TODO(adapter): level-based
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
  /**
   * Atomic visual outputs (images) — the sibling of lineBoxes for
   * blocks that never enter lines[]. Splice/prefix reuse shares these
   * frozen records zero-copy, exactly like lineBoxes.
   */
  placedRects: PlacedRect[]
  exitState: WalkState
  /**
   * UPSTREAM-DEPENDENCE RECORD: whether this placement consumed its
   * successor's first-line height (an ACTIVE bond lookahead at cache
   * time). Both directions matter: a successor edit invalidates a
   * consuming placement even when the current doc no longer carries
   * the bond (keepPrevious REMOVED), and a newly-added bond requires
   * consumption the cached placement never performed. Backward-resume
   * and the splice pull-back test BOTH the current flags and this
   * cached record.
   */
  bonded: boolean
  /**
   * NON-MARKOV RECORD: this placement was committed while its own
   * bond enforcement was dropped on a SPENT attempt — the
   * backward-cascade unwind re-walked this block within the same
   * call and the one-attempt budget was already gone. That outcome
   * depends on CALL HISTORY, not on (entry state, block, opts) alone
   * — a fresh call from the same entry state would enforce with a
   * fresh attempt (shape-1 move) instead of dropping. Such an entry
   * may NEVER be prefix-reused or spliced: the resume comparison and
   * the splice gate both refuse it, forcing a re-walk that
   * reproduces the placement under a fresh attempt. Caught by the
   * parity fuzzer (seed 1023 — an image successor's tall first
   * "line" made the violation reachable; the mechanism is
   * kind-agnostic and predates images).
   */
  danced: boolean
}

// Line-level cache: a block's LineResults depend only on (runs, the
// TWO wrap widths — base and line-0 — and baseStyle) — keyed by the
// block id, re-validated by hash. The indent family feeds both
// widths; both are part of the key.
interface CachedLines {
  contentHash: string
  maxWidth: number
  firstMaxWidth: number
  lines: LineResult[]
}

/**
 * Creates a layout engine bound to the given metrics port. The cache
 * lives inside the returned instance — the shell must hold ONE stable
 * engine instance (new metrics requires a new engine).
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
      // Loud adapter contracts, upfront — before any cache work.
      validateDuplicateIds(doc)
      validateIndentGeometry(doc)
      validateInlineInCode(doc)
      validateFloatFlow(doc)

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
      // All pages share opts geometry. TODO(sections): per-section
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

      // Resume = first index where [id, contentHash] differs — or the
      // first NON-MARKOV entry (a spent-attempt bond drop is
      // call-history-dependent and must be re-walked, never reused).
      // Length mismatch counts as a difference at the shorter length's end.
      let resume = Math.min(doc.blocks.length, oldCache.length)
      for (let i = 0; i < resume; i++) {
        if (
          doc.blocks[i].id !== oldCache[i].blockId ||
          hashes[i] !== oldCache[i].contentHash ||
          oldCache[i].danced
        ) {
          resume = i
          break
        }
      }

      // BACKWARD-RESUME through bonded chains: a bonded
      // predecessor's placement consumed its successor's first-line
      // height (the bond lookahead), so an edit inside the successor
      // can invalidate the predecessor's cached placement — extend the
      // resume point BACKWARD while the pair is bonded. BOTH signals
      // are tested: the CURRENT doc's bond flags (a newly-added bond
      // requires consumption the cached placement never performed) AND
      // the cached bonded record (a consuming placement is stale even
      // when the edit REMOVED the bond — e.g. keepPrevious deleted from
      // the successor; a fuzzer-caught hole). Conservative: a spurious
      // extension only re-walks, never mis-splices. blocksWalked counts
      // the re-walked bonded predecessors.
      while (resume > 0 && (bondExistsBetween(doc, resume - 1) || oldCache[resume - 1].bonded)) {
        resume -= 1
      }

      const lines: LineBox[] = []
      const breaks: FragmentBreak[] = []
      // ATOMIC VISUAL OUTPUT: images (and, additively, floats later).
      // Document order, the sibling of lines[] — images never appear
      // in lines[]; consumers merge the arrays by (pageIndex, rect.y).
      const placedOut: PlacedRect[] = []
      const newCache: WalkCacheEntry[] = []

      // Lemma 1: unchanged blocks + identical entry states ⇒ identical
      // outputs — the prefix is reused directly.
      for (let i = 0; i < resume; i++) {
        lines.push(...oldCache[i].lineBoxes)
        breaks.push(...oldCache[i].breaks)
        placedOut.push(...oldCache[i].placedRects)
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
        // ATOMIC IMAGES (E-IMG-1): the image's single synthetic "line"
        // — INTERNAL, never emitted into lines[]. Feeding it through
        // the SAME machinery (countFitting, firstLineLands, fitsFresh)
        // means one derivation of the fit/bond rules, not a parallel
        // image copy of them. Not cached and never counted in
        // linesRebroken: an image never breaks lines, and its dims are
        // per-call arithmetic over (intrinsic × contentBox).
        if (block.kind === 'image') {
          const dims = imagePlacedSize(
            block.width,
            block.height,
            contentBox.width,
            contentBox.height,
          )
          return [
            { start: 0, end: 0, segments: [], width: dims.width, height: dims.height, baseline: dims.height },
          ]
        }
        // INDENT FAMILY, effect 1 (line breaking): base lines wrap at
        // contentBox.width − indentLeft − indentRight; ONLY line 0
        // wraps at contentBox.width − (indentLeft + firstLineIndent) −
        // indentRight — a NEGATIVE firstLineIndent under a larger
        // indentLeft is the hanging style, so line 0 can wrap WIDER.
        // The cache key stores BOTH widths: a re-layout under different
        // indents (same content) must re-break even before the hash
        // misses.
        const maxWidth =
          contentBox.width - (block.indentLeft ?? 0) - (block.indentRight ?? 0)
        const firstMaxWidth = maxWidth - (block.firstLineIndent ?? 0)
        const cached = lineCache.get(block.id)
        const hash = hashes[index]
        if (
          cached &&
          cached.contentHash === hash &&
          cached.maxWidth === maxWidth &&
          cached.firstMaxWidth === firstMaxWidth
        ) {
          return cached.lines
        }
        // Kind routes the breaker: codeBlock breaks under source-line
        // semantics (explicit newlines honored, greedy character soft
        // wrap, whitespace preserved); paragraph/heading break at
        // spaces. Both produce LineResults consumed by the same
        // placement machine — code fragments BETWEEN lines exactly
        // like a paragraph (orphan/widow rules apply; the indent
        // family is block geometry for every kind).
        const results =
          block.kind === 'codeBlock'
            ? breakCodeLines(block.runs, metrics, maxWidth, doc.baseStyle, firstMaxWidth)
            : breakLines(block.runs, metrics, maxWidth, doc.baseStyle, firstMaxWidth)
        lineCache.set(block.id, {
          contentHash: hash,
          maxWidth,
          firstMaxWidth,
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
          placedOut.length -= popped.placedRects.length
        }
        newCache.push(entry)
        lines.push(...entry.lineBoxes)
        breaks.push(...entry.breaks)
        placedOut.push(...entry.placedRects)
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

        // Headings route through breakLines exactly like paragraphs —
        // heading entries in the walk cache are load-bearing.
        // TODO(adapter): level-based default styles arrive from the
        // ADAPTER; level is not a layout input here.
        const entryState = state
        // ANCHORED FLOAT (E-IMG-3, v1 wrap NONE): a floated image
        // enters the SAME walk machine but never placeBlock — zero
        // flow presence (the full model comment lives at placeFloat).
        // getLines is skipped entirely: no synthetic line, nothing to
        // fit, nothing to bond (validateFloatFlow refused flow).
        const floated = block.kind === 'image' && block.float != null
        const results: readonly LineResult[] = floated ? [] : getLines(i)
        const control = controlOf(block)
        const next = doc.blocks[i + 1]
        const bondExists =
          !floated &&
          next !== undefined &&
          (block.flow?.keepNext === true || next.flow?.keepPrevious === true)
        const structural =
          bondExists &&
          (block.flow?.breakAfter === 'page' || next.flow?.breakBefore === 'page')
        const bonded = bondExists && !structural

        let currentEntry = entryState
        let placed =
          block.kind === 'image' && block.float != null
            ? placeFloat(block, block.float, currentEntry, size, contentBox)
            : placeBlock(
                block, results, currentEntry, contentBox.width, contentBox.height,
                control, bonded, false,
              )
        let movedViaShape1 = false

        // BOND-DROP HISTORY FLAG: a placement committed while its own
        // bond enforcement was dropped on a SPENT attempt is a
        // call-history-dependent outcome (see WalkCacheEntry.danced)
        // — the one non-Markov flavor the walk produces. Everything
        // else (shape-1/shape-2 moves, vacuous drops, still-violated
        // stays) is a pure function of (entry state, block, opts) and
        // replays identically in a fresh call.
        let danced = false

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
          const lands = firstLineLands(
            next, nextLines, placed.exitState, contentBox.height, controlOf(next),
          )
          if (!lands) {
            if (!bondAttempts.has(i)) {
              bondAttempts.add(i)
              const fitsFresh =
                countFitting(results, 0, contentBox.height) === results.length
              if (fitsFresh && entryState.y > 0) {
                // SHAPE 1 (R1 shape): move A's start to the fresh page.
                currentEntry = { pageIndex: entryState.pageIndex + 1, y: 0 }
                placed = placeBlock(
                  block, results, currentEntry, contentBox.width, contentBox.height,
                  control, bonded, false,
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
                // For an ATOMIC image A this shape is vacuous by
                // construction (n == 1, never splits) → bounded drop.
                placed = placeBlock(
                  block, results, currentEntry, contentBox.width, contentBox.height,
                  control, bonded, true,
                )
              }
              // else: fitsFresh && entryState.y === 0 → VACUOUS
              // (impossible-after-move family): A already starts a
              // fresh page; moving re-creates the same situation
              // forever → the bond drops.
            } else {
              // SPENT-ATTEMPT DROP — the only history-dependent
              // outcome: the backward-cascade unwind re-walked this
              // block within the same call and the one-attempt
              // budget was gone. Flag the entry (never prefix-reused,
              // never spliced — a fresh call from the same entry
              // state would enforce with a fresh attempt instead).
              danced = true
            }
            // else: the attempt was already used this call → the
            // spent-attempt drop above (pinned by the composed
            // R2-re-fire flow test).
          }
        }

        commit(i, {
          blockId: block.id,
          contentHash: hashes[i],
          entryState: currentEntry,
          lineBoxes: placed.lineBoxes,
          breaks: placed.breaks,
          placedRects: placed.placedRects,
          exitState: placed.exitState,
          bonded,
          danced,
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
            firstPageOfOutputs(placed) !== lastPageOfEntry(prevEntry)
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
                  contentBox.width,
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
                  placedRects: prevPlaced.placedRects,
                  exitState: prevPlaced.exitState,
                  bonded: true, // this re-placement consumed block i's height
                  // Not danced: this shape-2 re-placement is part of a
                  // deterministic, fully replayable dance (the fresh
                  // call re-executes the same sequence with the same
                  // fresh attempts); only the spent-attempt drop is
                  // history-dependent.
                  danced: false,
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
        // id AND contentHash AND not-danced) verify. PROOF-PINNING:
        // exact === on the state floats is sound ONLY because warm
        // and cold walks execute the identical operation sequence
        // (same y-cursor additions, same order, same values); IEEE
        // guarantees bitwise-identical results. A refactor that
        // reorders accumulation breaks this proof silently — the
        // parity fuzzer is the tripwire. A gate FAILING on reordered
        // accumulation is merely a missed splice (safe); a gate
        // passing on unequal states is impossible under ===. The
        // `danced` refusal is the same discipline for the one
        // history-dependent placement flavor (see WalkCacheEntry).
        const preSpliceState = state
        let j = i + 1
        while (
          j < doc.blocks.length &&
          j < oldCache.length &&
          sameState(state, oldCache[j].entryState) &&
          doc.blocks[j].id === oldCache[j].blockId &&
          hashes[j] === oldCache[j].contentHash &&
          !oldCache[j].danced
        ) {
          lines.push(...oldCache[j].lineBoxes)
          breaks.push(...oldCache[j].breaks)
          placedOut.push(...oldCache[j].placedRects)
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
        // changed (or ended the run), so that context is stale. BOTH
        // signals tested: the cached bonded record (stale consumption
        // even if the edit removed the bond) AND the current bond
        // flags (a newly-added bond requires enforcement the cached
        // placement never performed). Un-consume trailing bonded
        // entries; the walk re-places them with a fresh lookahead.
        // Symmetric with the backward-resume rule at the prefix
        // boundary.
        while (
          j - 1 > i &&
          (bondExistsBetween(doc, j - 1) || oldCache[j - 1].bonded)
        ) {
          const popped = newCache.pop()!
          lines.length -= popped.lineBoxes.length
          breaks.length -= popped.breaks.length
          placedOut.length -= popped.placedRects.length
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

      // Pages derived: every opened page holds >= 1 line OR >= 1
      // placed rect (slicer invariant; an image-only page must
      // materialize — a trailing image would otherwise vanish).
      // Empty doc → 1 page.
      let maxPage = 0
      for (const line of lines) if (line.pageIndex > maxPage) maxPage = line.pageIndex
      for (const brk of breaks) if (brk.pageIndex > maxPage) maxPage = brk.pageIndex
      for (const rect of placedOut) if (rect.pageIndex > maxPage) maxPage = rect.pageIndex
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
      return { pages, lines, breaks, placed: placedOut, version }
    },

    get lastStats(): LastStats {
      return currentStats
    },
  }
}

/**
 * THE ONE horizontal-align derivation (M5.13): the x-offset of an
 * aligned rect of `placedWidth` within a content box of
 * `contentWidth`. Engine-owned and exported — the SHELL's paint and
 * caret MUST import this function, never re-derive: placed[].rect.x,
 * painted rects, and caret x agree by construction, not by
 * convention. `center` of the PLACED rect, not the intrinsic; left by
 * default. Un-clamped: a negative result is reachable only in
 * degenerate geometry (a placed rect wider than the box), placed
 * anyway per the R6 floor family.
 */
export function alignOffset(
  align: 'left' | 'center' | 'right',
  placedWidth: number,
  contentWidth: number,
): number {
  if (align === 'center') return (contentWidth - placedWidth) / 2
  if (align === 'right') return contentWidth - placedWidth
  return 0
}

/**
 * Image fit-down (E-IMG-1): the block placement's box — the ENGINE owns
 * this math (two-sided law: the shell must never scale; it imports the
 * primitive). Delegates to fitDownImage (line-breaker.ts) — the ONE
 * scale primitive, extracted in E-IMG-2 so the INLINE clamp shares the
 * formula with the block fit-down: one scale, no forked math. The
 * E-IMG-1 rulings (zero-dim degrade, 1px floor) live at the primitive.
 */
function imagePlacedSize(
  width: number,
  height: number,
  contentWidth: number,
  contentHeight: number,
): { width: number; height: number } {
  return fitDownImage(width, height, contentWidth, contentHeight)
}

// BOND LOOKAHEAD — predicts whether a block's FIRST line lands on the
// entry page, mirroring the placement machine's start decisions
// EXACTLY. The prediction must mirror "the same rules the walk
// applies" completely, or it isn't exact; every arm is listed:
//   - structural breakBefore: y > 0 → the page closes → next page.
//   - spaceBefore is consumed at entry, shrinking the fit budget;
//     the y > 0 guards below test line-top presence (entry.y), not
//     the padded cursor — spaceBefore is not content.
//   - R0: the whole block fits → stays.
//   - fits == 0: content on the page → R1 closes → next page; fresh
//     page → R6 places the first line by fiat → STAYS (degenerate: a
//     single line taller than the page still lands on the entry page —
//     the bond HOLDS).
//   - R2 orphan: fits == 1 && n > 1 && control && hasContent → next page.
//   - R-ATOMIC: keepLines && n <= cap while the block doesn't fit →
//     next page (cannot fire on a fresh page: n <= cap means the
//     unpadded fresh page fits the whole block, so R0 already fired —
//     with spaceBefore the hasContent guard pins it).
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
  const hasContent = entry.y > 0
  const n = lines.length
  const fits = countFitting(lines, 0, contentHeight - entry.y - (block.spaceBefore ?? 0))
  if (fits >= n) return true
  if (fits === 0) return !hasContent
  if (fits === 1 && n > 1 && control && hasContent) return false
  const cap = countFitting(lines, 0, contentHeight)
  if (block.flow?.keepLines === true && n <= cap && hasContent) return false
  return true
}

// Kind-agnostic output-page reads for the bond cascade: an ATOMIC
// image block's outputs live in placedRects, not lineBoxes (images
// never enter lines[]). Every block emits at least one output — a
// text block always has lines, an image always has its one placed
// rect — so the fallback chain is total. The image's single "line"
// IS its rect for bond purposes (the ToF #31 dependency).
function firstPageOfOutputs(out: {
  lineBoxes: LineBox[]
  placedRects: PlacedRect[]
}): number {
  return out.lineBoxes.length > 0
    ? out.lineBoxes[0].pageIndex
    : out.placedRects[0].pageIndex
}

function lastPageOfEntry(entry: WalkCacheEntry): number {
  return entry.lineBoxes.length > 0
    ? entry.lineBoxes[entry.lineBoxes.length - 1].pageIndex
    : entry.placedRects[entry.placedRects.length - 1].pageIndex
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

// The placement machine. PURE: a function of (block, LineResults,
// entry state, content-box size, widow control, bond context, split
// backup) — the Markov property made physically true of the code.
// `bonded` (an ACTIVE bond to the successor) preempts R3: when the
// bond already relocates A's last line onto B's page, the widow
// concern is void. `backupFinalSplit` is the one-shot shape-2 hook:
// the FINAL fragment places one line fewer, so A's last line opens
// the successor's page.
// ATOMIC IMAGES (E-IMG-1): an image arrives as ONE synthetic
// LineResult carrying its FINAL placed dims (fit-down already
// applied — the engine owns that math), so the whole rule family
// degenerates safely: R0 places it, R1/R6 close-or-floor, and R2/R3/
// R-ATOMIC can never fire (n == 1). Exactly one placement decision,
// never fragmented. The EMIT branch swaps the record kind: an image
// produces a frozen PlacedRect (never a LineBox — images don't enter
// lines[]), with rect.x from the shared alignOffset — the same
// function the shell's paint/caret consume (M5.13). The indent family
// is wrap geometry and is IGNORED for images; keepLines on an image
// is vacuous by construction.
function placeBlock(
  block: Block,
  results: readonly LineResult[],
  entryState: WalkState,
  contentWidth: number,
  contentHeight: number,
  control: boolean,
  bonded: boolean,
  backupFinalSplit: boolean,
): { lineBoxes: LineBox[]; breaks: FragmentBreak[]; placedRects: PlacedRect[]; exitState: WalkState } {
  const L = results.length
  // How many of THIS block's lines a fresh page holds — only the R4
  // exemption test and R-ATOMIC's n <= cap check consume it.
  const cap = countFitting(results, 0, contentHeight)
  const lineBoxes: LineBox[] = []
  const breaks: FragmentBreak[] = []
  const placedRects: PlacedRect[] = []
  let { pageIndex, y } = entryState

  // SPACE-BEFORE (block entry, applied ONCE): the first line's top
  // is pushed down by spaceBefore, so every fit count below evaluates
  // against the line tops. The y > 0 loop-freedom guards test
  // `hasContent` — whether the page already holds LINE tops — NOT the
  // spaceBefore-padded cursor: spaceBefore is not content, and a page
  // holding only spaceBefore is still fresh (closing it would violate
  // the never-empty-page invariant). A page close mid-machine (R1/R2/
  // R-ATOMIC/fragment) never re-applies spaceBefore: it was consumed
  // here, and closePage resets the cursor to a bare page top.
  let hasContent = entryState.y > 0
  y += block.spaceBefore ?? 0

  // INDENT FAMILY, effect 2 (placement): a line's rect.x is its
  // effective left edge and its width is the line's measured width —
  // produced by that line's wrap width, so rect.x and the wrap shift
  // together. indentLeft/indentRight are per-line horizontal
  // geometry: every fragment keeps them. firstLineIndent is the
  // one-shot member — the CONTINUATION RULE mirrors spaceBefore's:
  // lineIndex 0 (the block's true start, wherever the start rules
  // put it) sits at indentLeft + firstLineIndent and WRAPPED at that
  // width; every later line — including every line of a continuation
  // fragment on a later page — resumes at the BASE edge indentLeft.
  // validateIndentGeometry guarantees the line-0 edge is ≥ 0.
  const baseLeft = block.indentLeft ?? 0
  const firstLeft = baseLeft + (block.firstLineIndent ?? 0)
  // IMAGE EMIT GEOMETRY: align positions the PLACED rect within the
  // full content box via the shared alignOffset (center of the placed
  // rect, not the intrinsic). Computed once — an image is one line.
  const imageLeft =
    block.kind === 'image'
      ? alignOffset(block.align ?? 'left', results[0].width, contentWidth)
      : 0
  const place = (from: number, count: number): void => {
    for (let i = from; i < from + count; i++) {
      const result = results[i]
      if (block.kind === 'image') {
        // The ATOMIC emit: a PlacedRect, never a LineBox. src/alt are
        // opaque echoes — the engine never interprets them.
        placedRects.push(
          freezePlacedRect({
            blockId: block.id,
            kind: 'image',
            src: block.src,
            alt: block.alt,
            pageIndex,
            rect: { x: imageLeft, y, width: result.width, height: result.height },
          }),
        )
      } else {
        lineBoxes.push(
          freezeLineBox({
            blockId: block.id,
            lineIndex: i,
            pageIndex,
            rect: { x: i === 0 ? firstLeft : baseLeft, y, width: result.width, height: result.height },
            baseline: result.baseline,
            rangeStart: result.start,
            rangeEnd: result.end,
            segments: result.segments,
          }),
        )
      }
      y += result.height
      hasContent = true
    }
  }

  const closePage = (): void => {
    pageIndex += 1
    y = 0
    hasContent = false
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
      if (hasContent) {
        closePage() // R1
        continue
      }
      fits = 1 // R6: a fresh page always places one line
    }

    if (control && hasContent && fits === 1 && n > 1) {
      closePage() // R2 orphan: the block's start moves
      continue
    }

    if (k === 0 && hasContent && block.flow?.keepLines === true && n <= cap) {
      closePage() // R-ATOMIC: keepLines moves the whole block
      continue
    }

    if (control && !bonded && n - fits === 1 && fits > 1) {
      fits -= 1 // R3 widow (bond preempts when ACTIVE)
      if (fits === 1 && hasContent && n > 1) {
        closePage() // re-check R2 (inherits its content guard)
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

  // SPACE-AFTER: belongs to this block's exit cursor, so the NEXT
  // block's fits account for it (participates in fits). Never closes
  // a page itself — only a line placement ever closes pages.
  y += block.spaceAfter ?? 0

  return { lineBoxes, breaks, placedRects, exitState: { pageIndex, y } }
}

// ANCHORED FLOAT (E-IMG-3, v1 wrap NONE) — the model, in one breath:
// moves-with-text comes free — the anchor is the block's flow
// position, so reflowing text repositions the float. Wrap modes
// (square/tight) are a FUTURE issue; v1 floats do not affect line
// breaking. z is PAINT ORDER, not layout.
//
// ZERO FLOW PRESENCE: the block contributes nothing to the flow — no
// height, no spaceBefore/After on the cursor, no fits, no bonds
// (loud seam: validateFloatFlow), no fragmentation. Its walk-cache
// entry is pure placement data: exitState === entryState,
// lineBoxes/breaks empty, the one PlacedRect the entire output. The
// rect is a PURE function of (entry state, block, opts) — the Markov
// property holds; nothing history-dependent (the 'danced' family is
// untouched).
//
// ANCHOR + ANCHOR-FRAGMENT RULING (spec item 8, ruled in the
// pre-coding presentation): the anchor is the flow position where the
// block would have started — the walk cursor at its doc position,
// plus spaceBefore (the y a non-floated image's rect would have
// begun at; the cursor itself never moves). A v1 float sits BETWEEN
// blocks, so that cursor is always at a LINE boundary: when the
// preceding (anchor) paragraph fragments across a page boundary, the
// cursor is by construction on the page of the fragment that ENDS
// the block — the float belongs to the fragment where that flow
// position lands, even when a negative dy visually drags the rect
// over text living on an EARLIER fragment's page. pageIndex resolves
// from the ANCHOR, never from the shifted rect.
//
// RECT DERIVATION: anchor + (dx, dy), clamped to the FULL PAGE BOX
// (margins included — the page is the canvas; a float may sit IN the
// margin), emitted CONTENT-BOX-RELATIVE like every PlacedRect — a
// float in the margin carries negative x/y (or x beyond the content
// width); one frame for the whole placed[] array. The clamp bounds
// are the page box expressed in the content frame (see below). Dims:
// the unchanged E-IMG-1 fit-down (content box — a float never
// outgrows what a block image could); anchor x via the shared
// alignOffset (align stays meaningful for floats; the indent family
// stays ignored, the image family rule), then dx.
//
// Degenerate guard: a page box narrower/shorter than the placed rect
// (negative margins) clamps to the page's left/top edge — the
// Math.max(hi, lo) family, deterministic, never a loop.
function placeFloat(
  block: ImageBlock,
  float: { dx: number; dy: number; z: 'front' | 'behind' },
  entry: WalkState,
  size: Rect,
  contentBox: Rect,
): { lineBoxes: LineBox[]; breaks: FragmentBreak[]; placedRects: PlacedRect[]; exitState: WalkState } {
  const dims = imagePlacedSize(block.width, block.height, contentBox.width, contentBox.height)
  const anchorX = alignOffset(block.align ?? 'left', dims.width, contentBox.width)
  const anchorY = entry.y + (block.spaceBefore ?? 0)
  // PAGE-BOX CLAMP, expressed in the CONTENT frame (the emitted frame):
  // the page box [0, size.width] × [0, size.height] maps to
  // [−contentBox.x, size.width − w − contentBox.x] etc., so a float may
  // sit anywhere in the page INCLUDING the margins (negative
  // content-relative coordinates). Computing and clamping in the
  // emitted frame directly avoids a page-frame round trip whose IEEE
  // rounding would perturb a dy=0/dx=0 rect off its anchor — the rect
  // must be BIT-IDENTICAL to the anchor + offset when no clamp fires.
  // Degenerate guard: a page box narrower/shorter than the placed rect
  // (negative margins) clamps to the page's left/top edge — the
  // Math.max(hi, lo) family, deterministic, never a loop.
  const clamp = (value: number, lo: number, hi: number): number =>
    Math.min(Math.max(value, lo), Math.max(hi, lo))
  const x = clamp(
    anchorX + float.dx,
    -contentBox.x,
    size.width - dims.width - contentBox.x,
  )
  const y = clamp(
    anchorY + float.dy,
    -contentBox.y,
    size.height - dims.height - contentBox.y,
  )
  const rect: Rect = { x, y, width: dims.width, height: dims.height }
  return {
    lineBoxes: [],
    breaks: [],
    placedRects: [
      freezePlacedRect({
        blockId: block.id,
        kind: 'image',
        src: block.src,
        alt: block.alt,
        pageIndex: entry.pageIndex,
        rect,
        float: { dx: float.dx, dy: float.dy },
        z: float.z,
      }),
    ],
    exitState: entry,
  }
}

// Enforced immutability at creation: freeze the record and its rect
// (leaf records — idempotent, one-time cost). Same posture as
// freezeLineBox: emitted PlacedRects are shared zero-copy across
// results and the walk cache. E-IMG-3: a floated rect's float echo is
// frozen with it.
function freezePlacedRect(placed: PlacedRect): PlacedRect {
  Object.freeze(placed.rect)
  if (placed.float !== undefined) Object.freeze(placed.float)
  return Object.freeze(placed)
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
// placement: kind (all four kinds — and kind also routes the BREAKER
// and the EMIT: codeBlock vs prose semantics, image = atomic
// PlacedRect), runs (text + style), flow (keepLines/widowControl/
// bonds/forced breaks), the block-tier spacing (spaceBefore/
// spaceAfter — undefined-valued keys are dropped by stableStringify,
// so absent ≡ unset bit-for-bit), and the block-tier indent family
// (indentLeft/indentRight/firstLineIndent — placement geometry for
// text; for images they are IGNORED at placement but hash-covered
// anyway: uniform and conservative — an indent edit re-walks, never
// mis-splices). For IMAGES the hash covers src + width + height +
// align (the placement-relevant rule) AND alt: OPAQUE FIELDS
// PARTICIPATE WHEN THEY ECHO INTO OUTPUT — cache-relevance, not
// geometry-relevance, is the rule (placed[] echoes src and alt; a
// spliced-past alt edit would serve a stale echo and break parity).
// E-IMG-3 extends the same rule to float (placed[] echoes the rect
// and z). E-IMG-2: runs hash through the union dispatch — text runs
// {text, style} as before, inline objects by their full field set
// {kind, src, width, height, alt}.
// An id is NOT part of the hash — it is compared separately.
//
// IDENTITY CACHE: hashes are memoized on the block
// OBJECT. ADAPTER CONTRACT: the shell must reuse unchanged Block
// objects BY REFERENCE across layout calls (ProseMirror's structural
// sharing makes this natural — the app-side adapter caches on PM node
// identity). A shell that rebuilds all Block objects every call pays
// the full stringify again — correct, just unshared. Blocks are
// treated as immutable; a mutated
// block must be a NEW object (or the stale hash would be trusted —
// the parity fuzzer plus the hash-identity tests pin both directions).
const blockHashCache = new WeakMap<Block, string>()

function hashBlock(block: Block): string {
  let hash = blockHashCache.get(block)
  if (hash === undefined) {
    const base = {
      kind: block.kind,
      flow: block.flow,
      spaceBefore: block.spaceBefore,
      spaceAfter: block.spaceAfter,
      indentLeft: block.indentLeft,
      indentRight: block.indentRight,
      firstLineIndent: block.firstLineIndent,
    }
    hash = stableStringify(
      block.kind === 'image'
        ? {
            ...base,
            src: block.src,
            width: block.width,
            height: block.height,
            align: block.align,
            alt: block.alt,
            // E-IMG-3: float rides the hash — cache-relevant, not just
            // geometry-relevant: the placed rect AND z echo into
            // placed[], so a spliced-past float edit would serve a
            // stale echo (the E-IMG-1 alt ruling family). null is
            // dropped with undefined by stableStringify → absent ≡
            // unset bit-for-bit, so float-free image hashes are
            // unchanged.
            float: block.float ?? undefined,
          }
        : {
            ...base,
            runs: block.runs.map((run) =>
              // E-IMG-2 run union dispatch: an inline object's fields
              // are included BY CONSTRUCTION — the mapping names
              // kind/src/width/height/alt, so any of their edits
              // re-breaks the block. A text run maps to {text, style}
              // BIT-IDENTICALLY to the pre-union hash (an explicit
              // kind: 'text' is deliberately NOT hashed — absent ≡
              // 'text' ≡ unset, the stableStringify undefined-dropping
              // rule), so existing docs' hashes are unchanged.
              run.kind === 'inlineImage'
                ? {
                    kind: run.kind,
                    src: run.src,
                    width: run.width,
                    height: run.height,
                    alt: run.alt,
                  }
                : { text: run.text, style: run.style },
            ),
          },
    )
    blockHashCache.set(block, hash)
    hashCallCount += 1
  }
  return hash
}

// TEMP (validation): counts hashBlock stringification misses
// (cache misses). Remove once the identity cache is done being
// validated live.
export let hashCallCount = 0
export function resetHashCallCount() {
  hashCallCount = 0
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
// before any cache work. Also protects the id-keyed lineCache and
// the splice id-verification from ambiguity.
function validateDuplicateIds(doc: SemanticDoc): void {
  const seen = new Set<string>()
  for (const block of doc.blocks) {
    if (seen.has(block.id)) {
      throw new Error(`duplicate block id: ${block.id}`)
    }
    seen.add(block.id)
  }
}

// INDENT SEAM (loud, upfront — next to the duplicate-id gate): a first
// line whose computed left edge (indentLeft + firstLineIndent) is
// negative would start left of the content box. The engine REFUSES
// that geometry — no clipping, no silent shift. ADAPTER CONTRACT: the
// adapter must validate before sending; this throw is the backstop.
// Only the SUM is checked: a negative sum is the one way any line's
// left edge goes negative (base lines sit at indentLeft alone, which
// the same sum covers when firstLineIndent is 0).
function validateIndentGeometry(doc: SemanticDoc): void {
  for (const block of doc.blocks) {
    const left = (block.indentLeft ?? 0) + (block.firstLineIndent ?? 0)
    if (left < 0) {
      throw new Error(
        `block "${block.id}": indentLeft ${block.indentLeft ?? 0} + firstLineIndent ${block.firstLineIndent ?? 0} = ${left} < 0 — the first line would start left of the content box; the adapter must validate before sending`,
      )
    }
  }
}

// INLINE OBJECTS IN CODE BLOCKS (E-IMG-2, ruled in the pre-coding
// presentation — loud seam): codeBlock runs carry source-line text
// only; the adapter must never project an inline image into code.
// The shared breaker would seat an object mechanically (the ORC is a
// one-position token there too), but the CONTRACT is the seam —
// refuse loudly, never silently lay out an object the code semantics
// never defined. Unreachable through the public API without the
// adapter having built the runs, so this is an adapter-contract gate.
function validateInlineInCode(doc: SemanticDoc): void {
  for (const block of doc.blocks) {
    if (block.kind === 'codeBlock' && block.runs.some((run) => run.kind === 'inlineImage')) {
      throw new Error(
        `block "${block.id}": codeBlock runs carry an inline image — inline objects are refused in code blocks (source-line text only); the adapter must validate before sending`,
      )
    }
  }
}

// FLOAT FLOW SEAM (E-IMG-3, ruled — loud, upfront, the bonds family):
// a floated image is not in flow — it cannot bond and must not derive
// pages. keepNext/keepPrevious ON a floated block, a bond pointing
// INTO one (A.keepNext where B is floated; B.keepPrevious where A is
// floated), and breakBefore/breakAfter on a floated block are all
// adapter-contract violations: THROW, never a silent no-op. The
// adapter expresses "float here, text continues on a new page" with
// breakBefore on the FOLLOWING text block. null counts as UNSET at
// every check (the PM JSON round-trip convention). keepLines/
// widowControl on floats are NOT refused — vacuous by construction,
// the block-image precedent.
function validateFloatFlow(doc: SemanticDoc): void {
  for (const block of doc.blocks) {
    if (block.kind !== 'image' || block.float == null) continue
    const flow = block.flow
    if (flow?.keepNext === true || flow?.keepPrevious === true) {
      throw new Error(
        `block "${block.id}": floated image carries keepNext/keepPrevious — a float is not in flow and cannot bond; the adapter must validate before sending`,
      )
    }
    if (flow?.breakBefore === 'page' || flow?.breakAfter === 'page') {
      throw new Error(
        `block "${block.id}": floated image carries breakBefore/breakAfter — a float must not derive pages; put the forced break on the following text block instead`,
      )
    }
  }
  for (let i = 0; i + 1 < doc.blocks.length; i++) {
    const a = doc.blocks[i]
    const b = doc.blocks[i + 1]
    const aFloat = a.kind === 'image' && a.float != null
    const bFloat = b.kind === 'image' && b.float != null
    if ((aFloat || bFloat) && (a.flow?.keepNext === true || b.flow?.keepPrevious === true)) {
      throw new Error(
        `blocks "${a.id}" → "${b.id}": bond touches a floated image — a float is not in flow and cannot bond; the adapter must validate before sending`,
      )
    }
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
