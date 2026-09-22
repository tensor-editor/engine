import type { LineResult, LineSegment, Run, TextMetrics, TextStyle } from './types.js'

// M1 greedy line breaker — deliberately simple: greedy fill; break at
// spaces only; trim the space at the break; no hyphenation; hard-split
// tokens longer than the line.
// TODO(M3+): proper UAX #14 line breaking, whitespace collapsing,
// hyphenation, overflow policy.

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
    // the engine). Fulfilled by M2 baseStyle. Width stays 0 (no glyphs).
    const ascent = metrics.ascent(baseStyle)
    const descent = metrics.descent(baseStyle)
    return [{
      start: 0,
      end: 0,
      segments: [],
      width: 0,
      height: ascent + descent,
      baseline: ascent,
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

  // Vertical metrics over the runs a line actually contains: max ascent
  // and max descent taken independently.
  function verticalFor(start: number, end: number): { height: number; baseline: number } {
    let ascent = 0
    let descent = 0
    for (const { run, start: rs, end: re } of runRanges) {
      if (Math.max(start, rs) < Math.min(end, re)) {
        ascent = Math.max(ascent, metrics.ascent(run.style))
        descent = Math.max(descent, metrics.descent(run.style))
      }
    }
    return { height: ascent + descent, baseline: ascent }
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
      // terminates. TODO(M2+): overflow policy (shrink/clip).
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
