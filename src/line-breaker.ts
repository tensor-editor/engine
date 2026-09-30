import type { LineResult, LineSegment, Run, TextMetrics, TextStyle } from './types.js'

// ONE SCALE PRIMITIVE (extracted in E-IMG-2, from E-IMG-1's block
// fit-down): the aspect-preserving image fit-down shared by the BLOCK
// placement (layout.ts's imagePlacedSize — both axes against the
// content box) and the INLINE clamp (below — width only, maxHeight
// Infinity) — one formula, no forked math. The engine owns this math
// (two-sided law): the SHELL must never scale — it IMPORTS this
// function for paint (the alignOffset precedent, M5.13), never
// re-derives. Down-only: natural size when both axes fit, else scale
// by the binding axis. Degenerate guards, both commented at their
// sites: a zero-dim intrinsic degrades to 1×1, and the 1px floor is
// unreachable except in a degenerate box.
export function fitDownImage(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  // ZERO-DIM GUARD (loud-seam family — NO throw): ANY non-positive or
  // non-finite axis (per-axis trigger, not just both-zero — a 100×0
  // image is as degenerate as a 0×0 one) degrades the WHOLE intrinsic
  // to 1×1; the valid axis is not preserved, because half an image is
  // not an image. ADAPTER CONTRACT: the shell should prevent zero-dim
  // images before sending; this is the engine's deterministic
  // backstop, never a license to send them.
  const degenerate =
    !(Number.isFinite(width) && width > 0) || !(Number.isFinite(height) && height > 0)
  const w = degenerate ? 1 : width
  const h = degenerate ? 1 : height
  const scale = Math.min(maxWidth / w, maxHeight / h, 1)
  let placedW = w * scale
  let placedH = h * scale
  // 1px FLOOR (R6 floor family): only reachable when the box itself is
  // degenerate (maxWidth/maxHeight <= 0 makes the scale 0) — a line or
  // content box too small for any image still PLACES it, never loops.
  // The aspect breaks only here, in geometry that cannot hold any
  // image at all.
  if (!(placedW > 0)) placedW = 1
  if (!(placedH > 0)) placedH = 1
  return { width: placedW, height: placedH }
}

// The inline-object token (E-IMG-2): OBJECT REPLACEMENT CHARACTER —
// exactly ONE position per object in the block's concatenated text.
// Chosen so it can never collide with content semantics: not a space
// (so never a break point), length 1 (so never split mid-object), and
// the Unicode standard's own placeholder for an inline object.
const OBJECT_CHAR = '\uFFFC'

// Greedy line breaker — deliberately simple: greedy fill; break at
// spaces only; trim the space at the break; no hyphenation; hard-split
// tokens longer than the line.
// TODO: proper UAX #14 line breaking, whitespace collapsing,
// hyphenation, overflow policy.
//
// The CODE breaker (breakCodeLines, below) is deliberately different:
// source-line semantics for codeBlock blocks.

// BOTTOM-ONLY LEADING (M6 RULING — spec of record): with content
// height c = a + d and lineHeight multiplier lh, the line box is
// c × lh tall and the baseline sits at `ascent` from the box top —
// ALL the leading (c × lh − c) lives BELOW the glyphs.
// Rationale: the top-left of a line box is always text; inter-line
// space lives below; above-line space is owned by the block tier
// (spaceBefore/spaceAfter), never by the line. Word-family
// convention, deliberately replacing the CSS half-leading model.
// lineHeight absent or 1.0 returns (c, a) bit-identically to the
// lineHeight-free model.
function lineBoxVertical(ascent: number, descent: number, style: TextStyle): {
  height: number
  baseline: number
} {
  const content = ascent + descent
  const height = content * (style.lineHeight ?? 1.0)
  return { height, baseline: ascent }
}

// Shared per-breaker machinery: run ranges over the concatenated
// text plus the measure/segment/vertical helpers. Both breakers
// (prose + code) consume the same LineResult shape.
//
// E-IMG-2: runs are a discriminated union. A TEXT run contributes its
// text; an INLINE IMAGE run contributes exactly ONE position (the
// OBJECT_CHAR token) and its placed dims — width from dims, never a
// metrics call (dims are data, the M5.6+ ruling; the metrics port is
// not consulted for objects).
interface PreparedText {
  run: Run
  start: number
  end: number
  text: string
  style: TextStyle
}
interface PreparedObject {
  run: Run
  start: number
  end: number
  dims: { width: number; height: number }
}

// P1 helper for the Run union: a PRESENT run's style wins over
// baseStyle — but an inlineImage run carries no style. len === 0
// implies every present run is a zero-length TEXT run (an inline
// object always occupies one position), so the pick is unchanged for
// every existing corpus; the scan exists for the union's type safety.
function firstTextStyle(runs: readonly Run[]): TextStyle | undefined {
  for (const run of runs) {
    if (run.kind !== 'inlineImage') return run.style
  }
  return undefined
}

function prepare(runs: readonly Run[], metrics: TextMetrics, objectMaxWidth: number) {
  const parts: string[] = []
  const runRanges: (PreparedText | PreparedObject)[] = []
  let offset = 0
  for (const run of runs) {
    if (run.kind === 'inlineImage') {
      // INLINE CLAMP (E-IMG-2): an object wider than the BASE wrap
      // width clamps to it, aspect preserved, height scaling with it
      // — the SAME fit-down primitive as block images (one scale, no
      // forked math). The clamp uses the BASE width, never the
      // narrower first-line width: dims must not depend on which line
      // the object lands on. NO height clamp for inline objects — a
      // tall object GROWS its line; the slicer's R6 floor handles an
      // over-tall one like any single line.
      runRanges.push({
        run,
        start: offset,
        end: offset + 1,
        dims: fitDownImage(run.width, run.height, objectMaxWidth, Infinity),
      })
      parts.push(OBJECT_CHAR)
      offset += 1
    } else {
      runRanges.push({ run, start: offset, end: offset + run.text.length, text: run.text, style: run.style })
      parts.push(run.text)
      offset += run.text.length
    }
  }
  const concatenated = parts.join('')
  const len = concatenated.length

  // Measured width of [start,end): sum of per-run intersections, each
  // measured under that run's style. Never assumes per-char additivity
  // (real fonts kern). An inline object contributes its PLACED WIDTH
  // — data, never measured.
  function lineWidth(start: number, end: number): number {
    let width = 0
    for (const pr of runRanges) {
      const a = Math.max(start, pr.start)
      const b = Math.min(end, pr.end)
      if (a < b) {
        if ('dims' in pr) width += pr.dims.width
        else width += metrics.measure(pr.text.slice(a - pr.start, b - pr.start), pr.style)
      }
    }
    return width
  }

  // SEGMENT EMISSION + PAINT-DATA CONTRACT (E-IMG-2, ruled in the
  // pre-coding presentation): one position per object in concatenated
  // text; the shell maps PM inline node offsets to run positions via
  // this contract. The segment covering an object's position
  // references the object run's runIndex (the object marker) — paint
  // dispatches on it. The SHELL resolves src/dims/alt by correlating
  // (blockId → its own adapter output → runs[runIndex]): it holds the
  // SemanticDoc it fed in, so correlation is legal, and LayoutResult
  // stays lean — the engine never echoes run data into lines or
  // segments. The object's final placed dims are derived by importing
  // the same fitDownImage primitive (the alignOffset precedent),
  // never a forked formula.
  function segmentsFor(start: number, end: number): LineSegment[] {
    const segments: LineSegment[] = []
    runRanges.forEach((pr, runIndex) => {
      const a = Math.max(start, pr.start)
      const b = Math.min(end, pr.end)
      if (a < b) segments.push({ runIndex, start: a, end: b })
    })
    return segments
  }

  // BOTTOM-LEADING MODEL (M6 ruling), per run: leading L =
  // (a + d) × lineHeight − (a + d); the whole leading extends the box
  // BELOW the glyphs:
  //   boxAscent = a, boxDescent = d + L
  // A line's height/baseline are the max extents over its runs. For a
  // single run this reduces exactly to the ruling:
  //   height = (a + d) × lineHeight
  //   baseline = ascent
  // INVARIANT: lineHeight absent or 1.0 gives L == 0, so boxAscent == a
  // and boxDescent == d bit-identically — numbers match the
  // lineHeight-free model exactly (pinned by tests).
  function verticalFor(start: number, end: number): { height: number; baseline: number } {
    let boxAscent = 0
    let boxDescent = 0
    for (const pr of runRanges) {
      if (Math.max(start, pr.start) < Math.min(end, pr.end)) {
        if ('dims' in pr) {
          // SEATING RULE (E-IMG-2 — CSS default): an inline image
          // sits ON the baseline — its BOTTOM at the baseline. It
          // extends imageHeight ABOVE the baseline and nothing below:
          // ascent contribution = placed height, descent contribution
          // = 0. No lineHeight multiplier — dims are data (M5.6+), not
          // font metrics: the object's box is exactly its height. Line
          // height = max over runs as today.
          boxAscent = Math.max(boxAscent, pr.dims.height)
        } else {
          const a = metrics.ascent(pr.style)
          const d = metrics.descent(pr.style)
          const leading = (a + d) * (pr.style.lineHeight ?? 1.0) - (a + d)
          boxAscent = Math.max(boxAscent, a)
          boxDescent = Math.max(boxDescent, d + leading)
        }
      }
    }
    return { height: boxAscent + boxDescent, baseline: boxAscent }
  }

  function makeLine(start: number, end: number): LineResult {
    const { height, baseline } = verticalFor(start, end)
    return {
      start,
      end,
      segments: segmentsFor(start, end),
      width: lineWidth(start, end),
      height,
      baseline,
    }
  }

  return { concatenated, len, lineWidth, segmentsFor, verticalFor, makeLine }
}

// FIRST-LINE WIDTH (the firstLineIndent seam): both breakers take an
// optional fifth width. When given, the block's line 0 — the FIRST
// LineResult produced — wraps at firstMaxWidth instead of maxWidth;
// every later line uses maxWidth. Bit-identical to the 4-arg call
// when omitted (or when the two widths are equal).
export function breakLines(
  runs: readonly Run[],
  metrics: TextMetrics,
  maxWidth: number,
  baseStyle: TextStyle,
  firstMaxWidth?: number,
): LineResult[] {
  const { concatenated, len, lineWidth, makeLine } = prepare(runs, metrics, maxWidth)

  if (len === 0) {
    // EMPTY-LINE METRICS (P1 ruling): a PRESENT run's style wins over
    // baseStyle — a zero-length run still carries its style, and the
    // adapter's empty-textblock projection (one zero-length run with
    // the paragraph's effective style) depends on it: an empty
    // paragraph in a 2.0-spaced doc must measure 2.0. baseStyle
    // remains the fallback only when there are NO runs at all (the
    // true empty-document case; REQUIRED, supplied by the adapter —
    // defaults live at the edges, never in the engine). Width stays 0.
    // Run union: firstTextStyle keeps the pick identical (an inline
    // object always occupies one position, so a len-0 block's present
    // runs are all zero-length TEXT runs).
    const style = firstTextStyle(runs) ?? baseStyle
    const ascent = metrics.ascent(style)
    const descent = metrics.descent(style)
    const { height, baseline } = lineBoxVertical(ascent, descent, style)
    return [{
      start: 0,
      end: 0,
      segments: [],
      width: 0,
      height,
      baseline,
    }]
  }

  // Last space index in (from, to] — a space at `from` never counts
  // (it would make an empty line and loop forever).
  function lastSpaceIn(from: number, to: number): number {
    for (let i = to; i > from; i--) {
      if (concatenated[i] === ' ') return i
    }
    return -1
  }

  const lines: LineResult[] = []
  let start = 0
  // Only the block's line 0 wraps at firstMaxWidth — consumed by the
  // first line pushed, whatever branch produces it.
  let first = true
  while (start < len) {
    const w = first && firstMaxWidth !== undefined ? firstMaxWidth : maxWidth
    if (lineWidth(start, len) <= w) {
      lines.push(makeLine(start, len))
      break
    }
    // Largest prefix of the remainder that fits.
    let fit = start
    while (fit < len && lineWidth(start, fit + 1) <= w) fit++
    if (fit === start) {
      // Even a single char overflows: emit it anyway so layout
      // terminates. TODO: overflow policy (shrink/clip). For an
      // inline OBJECT this floor fires only when the object is wider
      // than the CURRENT line's width — degenerate geometry, or line
      // 0's narrower first-line width when the block STARTS with a
      // clamped object (line 0 cannot be empty, so the floor is
      // forced); mid-line, an object that doesn't fit the remaining
      // width moves to the next line WHOLE instead (the branches
      // below).
      fit = start + 1
      lines.push(makeLine(start, fit))
      start = fit
      first = false
      continue
    }
    const s = lastSpaceIn(start, fit)
    if (s !== -1) {
      lines.push(makeLine(start, s)) // trim the space at the break
      start = s + 1
    } else {
      lines.push(makeLine(start, fit)) // hard-split the overlong token
      start = fit
    }
    first = false
  }

  return lines
}

// CODE BREAKING (codeBlock) — SOURCE-LINE SEMANTICS, the v1 rulings:
//
// 1. EXPLICIT NEWLINES ARE HONORED: the concatenated text splits at
//    every '\n'; each source line yields ≥1 LineBox. An EMPTY source
//    line (including the one a trailing '\n' opens) yields an EMPTY
//    LineBox — width 0, full height — like a code editor's blank
//    line. What a <pre> would show is what this emits.
// 2. SOFT WRAP IS GREEDY CHARACTER WRAP (v1 ruling): a source line
//    longer than the wrap width breaks at the last fitting CHARACTER
//    — anywhere, not at spaces. Code must not reflow words; column
//    alignment is the content's own business.
//    TODO: hanging indent / wrap markers for soft-wrapped code lines.
// 3. WHITESPACE IS PRESERVED EXACTLY: leading whitespace is never
//    trimmed and internal spaces never collapse — both would corrupt
//    code's column semantics. Every char of a source line appears in
//    exactly one LineBox.
// 4. The '\n' itself belongs to NO LineBox range — it is a separator
//    (same ruling as the prose breaker's trimmed break space): line
//    k ends right before it, line k+1 starts right after it.
// 5. An EMPTY source line has no chars of its own to measure under,
//    so it measures under the FIRST run's style — the code font — so
//    a blank line is exactly as tall as its siblings (baseStyle
//    would misalign a block whose code font is a different size). A
//    block with no text at all follows the same P1 rule: a present
//    (even zero-length) run's style wins; baseStyle only when there
//    are no runs, see breakLines.
export function breakCodeLines(
  runs: readonly Run[],
  metrics: TextMetrics,
  maxWidth: number,
  baseStyle: TextStyle,
  firstMaxWidth?: number,
): LineResult[] {
  const { concatenated, len, lineWidth, makeLine } = prepare(runs, metrics, maxWidth)

  if (len === 0) {
    // Same P1 ruling as prose: a PRESENT (even zero-length) run's
    // style wins over baseStyle; baseStyle is the no-runs-at-all
    // fallback only. Run union: firstTextStyle (see breakLines).
    const style = firstTextStyle(runs) ?? baseStyle
    const ascent = metrics.ascent(style)
    const descent = metrics.descent(style)
    const { height, baseline } = lineBoxVertical(ascent, descent, style)
    return [{ start: 0, end: 0, segments: [], width: 0, height, baseline }]
  }

  const emptyLine = (at: number): LineResult => {
    const style = firstTextStyle(runs) ?? baseStyle
    const ascent = metrics.ascent(style)
    const descent = metrics.descent(style)
    const { height, baseline } = lineBoxVertical(ascent, descent, style)
    return { start: at, end: at, segments: [], width: 0, height, baseline }
  }

  const lines: LineResult[] = []
  let segStart = 0
  // FIRST-LINE WIDTH ruling for code: the special width belongs to
  // the block's very FIRST LineBox (lineIndex 0) — even when that is
  // an empty first source line — and is consumed by it. A soft-wrapped
  // overflow of the first source line continues at the BASE width:
  // only lineIndex 0 carries the first-line indent, by the family's
  // uniform rule.
  let first = true
  while (segStart <= len) {
    // Source line = [segStart, nl), nl = the next '\n' or text end.
    const nl = concatenated.indexOf('\n', segStart)
    const segEnd = nl === -1 ? len : nl
    if (segStart === segEnd) {
      lines.push(emptyLine(segStart)) // honored blank line
      first = false
    } else {
      // Greedy CHARACTER wrap within the source line.
      let start = segStart
      while (start < segEnd) {
        const w = first && firstMaxWidth !== undefined ? firstMaxWidth : maxWidth
        if (lineWidth(start, segEnd) <= w) {
          lines.push(makeLine(start, segEnd))
          break
        }
        let fit = start
        while (fit < segEnd && lineWidth(start, fit + 1) <= w) fit++
        if (fit === start) {
          // Even a single char overflows: emit it anyway so layout
          // terminates (same ruling as prose). TODO: overflow policy.
          fit = start + 1
        }
        lines.push(makeLine(start, fit))
        start = fit
        first = false
      }
    }
    if (nl === -1) break
    segStart = nl + 1
  }

  return lines
}
