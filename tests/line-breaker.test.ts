import { describe, expect, it } from 'vitest'
import { breakLines } from '../src/line-breaker.js'
import { FakeMetrics } from './fake-metrics.js'
import type { Run, TextStyle } from '../src/types.js'

// FakeMetrics: 10px per char, so maxWidth 100 = 10 chars of headroom.
const maxWidth = 100

const style: TextStyle = { fontFamily: 'sans-serif', fontSize: 16 }
const bold: TextStyle = { fontFamily: 'sans-serif', fontSize: 16, bold: true }
// Document default font: feeds empty-line metrics (M2 baseStyle).
const baseStyle: TextStyle = { fontFamily: 'sans-serif', fontSize: 16 }

const run = (text: string, s: TextStyle = style): Run => ({ text, style: s })

describe('breakLines (M1 greedy breaker)', () => {
  it('empty runs produce exactly one empty line', () => {
    for (const runs of [[], [run('')]] as const) {
      const lines = breakLines(runs, FakeMetrics, maxWidth, baseStyle)
      expect(lines).toHaveLength(1)
      expect(lines[0].start).toBe(0)
      expect(lines[0].end).toBe(0)
      expect(lines[0].segments).toEqual([])
      // M2 baseStyle: no runs to measure → baseStyle metrics.
      // ascent 0.85 × 16 + descent 0.25 × 16 = 17.6; baseline 13.6.
      expect(lines[0].width).toBe(0)
      expect(lines[0].height).toBeCloseTo(17.6)
      expect(lines[0].baseline).toBeCloseTo(13.6)
    }
  })

  it('text that fits produces a single line', () => {
    const lines = breakLines([run('hi')], FakeMetrics, maxWidth, baseStyle)
    expect(lines).toHaveLength(1)
    expect(lines[0].start).toBe(0)
    expect(lines[0].end).toBe(2)
    expect(lines[0].width).toBe(20)
  })

  it('breaks at spaces, trims the break space, and keeps offsets contiguous', () => {
    const text = 'aaa bbb ccc'
    const lines = breakLines([run(text)], FakeMetrics, maxWidth, baseStyle)

    expect(lines.map((l) => [l.start, l.end])).toEqual([
      [0, 7], // "aaa bbb"
      [8, 11], // "ccc"
    ])

    // Contiguity: no overlaps, and the only skipped chars are exactly
    // the trimmed break spaces — every other char is in exactly one line.
    const covered = new Array<number>(text.length).fill(0)
    for (const line of lines) {
      for (let c = line.start; c < line.end; c++) covered[c]++
    }
    for (let c = 0; c < text.length; c++) {
      expect(covered[c]).toBeLessThanOrEqual(1)
      if (text[c] === ' ' && covered[c] === 0) continue // trimmed break space
      expect(covered[c]).toBe(1)
    }
    for (let i = 0; i + 1 < lines.length; i++) {
      expect(lines[i + 1].start).toBeGreaterThanOrEqual(lines[i].end)
    }
  })

  it('preserves run boundaries across breaking', () => {
    const lines = breakLines([run('foo', bold), run(' bar')], FakeMetrics, maxWidth, baseStyle)
    expect(lines).toHaveLength(1)
    expect(lines[0].start).toBe(0)
    expect(lines[0].end).toBe(7)
    expect(lines[0].segments).toEqual([
      { runIndex: 0, start: 0, end: 3 },
      { runIndex: 1, start: 3, end: 7 },
    ])
  })

  it('hard-splits an unbroken overlong token at the overflow char', () => {
    const lines = breakLines([run('abcdefghijklmno')], FakeMetrics, maxWidth, baseStyle)
    expect(lines.map((l) => [l.start, l.end])).toEqual([
      [0, 10],
      [10, 15],
    ])
  })

  it('lineHeight 2.0 doubles height and shifts the baseline by the half-leading', () => {
    // a = 13.6, d = 4, content = 17.6 → height = 35.2;
    // baseline = 13.6 + (35.2 − 17.6) / 2 = 13.6 + 8.8 = 22.4.
    const tall: TextStyle = { fontFamily: 'sans-serif', fontSize: 16, lineHeight: 2.0 }
    const lines = breakLines([run('hi', tall)], FakeMetrics, maxWidth, baseStyle)
    expect(lines[0].height).toBeCloseTo(35.2)
    expect(lines[0].baseline).toBeCloseTo(22.4)
  })

  it('lineHeight absent or 1.0 is bit-identical to the lineHeight-free model', () => {
    const plain = run('hi')
    const one = run('hi', { fontFamily: 'sans-serif', fontSize: 16, lineHeight: 1.0 })
    const a = breakLines([plain], FakeMetrics, maxWidth, baseStyle)
    const b = breakLines([one], FakeMetrics, maxWidth, baseStyle)
    // toBe, not toBeCloseTo: the invariant is bit-exact equality.
    expect(b[0].height).toBe(a[0].height)
    expect(b[0].baseline).toBe(a[0].baseline)
    // ...and both equal today's known numbers.
    expect(a[0].height).toBeCloseTo(17.6)
    expect(a[0].baseline).toBeCloseTo(13.6)
  })

  it('lineHeight applies to the empty-line baseStyle fallback too', () => {
    const tallBase: TextStyle = { fontFamily: 'sans-serif', fontSize: 16, lineHeight: 2.0 }
    const lines = breakLines([], FakeMetrics, maxWidth, tallBase)
    expect(lines[0].height).toBeCloseTo(35.2)
    expect(lines[0].baseline).toBeCloseTo(22.4)
  })
})
