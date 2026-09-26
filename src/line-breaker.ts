import type { LineResult, LineSegment, Run, TextMetrics, TextStyle } from './types.js'

// Greedy line breaker — deliberately simple: greedy fill; break at
// spaces only; trim the space at the break; no hyphenation; hard-split
// tokens longer than the line.
// TODO: proper UAX #14 line breaking, whitespace collapsing,
// hyphenation, overflow policy.

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

export function breakLines(
  runs: readonly Run[],
  metrics: TextMetrics,
  maxWidth: number,
  baseStyle: TextStyle,
): LineResult[] {
  const concatenated = runs.map((run) => run.text).join('')
  const len = concatenated.length

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
  while (start < len) {
    if (lineWidth(start, len) <= maxWidth) {
      lines.push(makeLine(start, len))
      break
    }
    // Largest prefix of the remainder that fits.
    let fit = start
    while (fit < len && lineWidth(start, fit + 1) <= maxWidth) fit++
    if (fit === start) {
      // Even a single char overflows: emit it anyway so layout
      // terminates. TODO: overflow policy (shrink/clip).
      fit = start + 1
      lines.push(makeLine(start, fit))
      start = fit
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
  }

  return lines
}
