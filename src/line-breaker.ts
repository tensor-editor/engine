import type { LineResult, LineSegment, Run, TextMetrics, TextStyle } from './types.js'

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
function prepare(runs: readonly Run[], metrics: TextMetrics) {
  const concatenated = runs.map((run) => run.text).join('')
  const len = concatenated.length

  // Absolute [start,end) of each run within the concatenated text.
  const runRanges: { run: Run; start: number; end: number }[] = []
  let offset = 0
  for (const run of runs) {
    runRanges.push({ run, start: offset, end: offset + run.text.length })
    offset += run.text.length
  }

  // Measured width of [start,end): sum of per-run intersections, each
  // measured under that run's style. Never assumes per-char additivity
  // (real fonts kern).
  function lineWidth(start: number, end: number): number {
    let width = 0
    for (const { run, start: rs, end: re } of runRanges) {
      const a = Math.max(start, rs)
      const b = Math.min(end, re)
      if (a < b) {
        width += metrics.measure(run.text.slice(a - rs, b - rs), run.style)
      }
    }
    return width
  }

  function segmentsFor(start: number, end: number): LineSegment[] {
    const segments: LineSegment[] = []
    runRanges.forEach(({ start: rs, end: re }, runIndex) => {
      const a = Math.max(start, rs)
      const b = Math.min(end, re)
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
    for (const { run, start: rs, end: re } of runRanges) {
      if (Math.max(start, rs) < Math.min(end, re)) {
        const a = metrics.ascent(run.style)
        const d = metrics.descent(run.style)
        const leading = (a + d) * (run.style.lineHeight ?? 1.0) - (a + d)
        boxAscent = Math.max(boxAscent, a)
        boxDescent = Math.max(boxDescent, d + leading)
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
  const { concatenated, len, lineWidth, makeLine } = prepare(runs, metrics)

  if (len === 0) {
    // A line with no runs has no style of its own to measure, so its
    // height/baseline fall back to the document baseStyle (REQUIRED,
    // supplied by the adapter — defaults live at the edges, never in
    // the engine). Width stays 0 (no glyphs). The bottom-only leading
    // model applies to baseStyle.lineHeight.
    const ascent = metrics.ascent(baseStyle)
    const descent = metrics.descent(baseStyle)
    const { height, baseline } = lineBoxVertical(ascent, descent, baseStyle)
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
      // terminates. TODO: overflow policy (shrink/clip).
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
//    block with no text at all keeps the prose empty-document
//    fallback (baseStyle), see breakLines.
export function breakCodeLines(
  runs: readonly Run[],
  metrics: TextMetrics,
  maxWidth: number,
  baseStyle: TextStyle,
  firstMaxWidth?: number,
): LineResult[] {
  const { concatenated, len, lineWidth, makeLine } = prepare(runs, metrics)

  if (len === 0) {
    // Same empty-document fallback as prose: a line with no runs has
    // no style of its own to measure.
    const ascent = metrics.ascent(baseStyle)
    const descent = metrics.descent(baseStyle)
    const { height, baseline } = lineBoxVertical(ascent, descent, baseStyle)
    return [{ start: 0, end: 0, segments: [], width: 0, height, baseline }]
  }

  const emptyLine = (at: number): LineResult => {
    const style = runs[0]?.style ?? baseStyle
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
