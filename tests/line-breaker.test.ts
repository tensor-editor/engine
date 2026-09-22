import { describe, expect, it } from 'vitest'
import { breakLines } from '../src/line-breaker.js'
import { FakeMetrics } from './fake-metrics.js'
import type { Run, TextStyle } from '../src/types.js'

// FakeMetrics: 10px per char, so maxWidth 100 = 10 chars of headroom.
const maxWidth = 100

const style: TextStyle = { fontFamily: 'sans-serif', fontSize: 16 }
const bold: TextStyle = { fontFamily: 'sans-serif', fontSize: 16, bold: true }

const run = (text: string, s: TextStyle = style): Run => ({ text, style: s })

describe('breakLines (M1 greedy breaker)', () => {
  it('empty runs produce exactly one empty line', () => {
    for (const runs of [[], [run('')]] as const) {
      const lines = breakLines(runs, FakeMetrics, maxWidth)
      expect(lines).toHaveLength(1)
      expect(lines[0].start).toBe(0)
      expect(lines[0].end).toBe(0)
      expect(lines[0].segments).toEqual([])
    }
  })

  it('text that fits produces a single line', () => {
    const lines = breakLines([run('hi')], FakeMetrics, maxWidth)
    expect(lines).toHaveLength(1)
    expect(lines[0].start).toBe(0)
    expect(lines[0].end).toBe(2)
    expect(lines[0].width).toBe(20)
  })

  it('breaks at spaces, trims the break space, and keeps offsets contiguous', () => {
    const text = 'aaa bbb ccc'
    const lines = breakLines([run(text)], FakeMetrics, maxWidth)

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
    const lines = breakLines([run('foo', bold), run(' bar')], FakeMetrics, maxWidth)
    expect(lines).toHaveLength(1)
    expect(lines[0].start).toBe(0)
    expect(lines[0].end).toBe(7)
    expect(lines[0].segments).toEqual([
      { runIndex: 0, start: 0, end: 3 },
      { runIndex: 1, start: 3, end: 7 },
    ])
  })

  it('hard-splits an unbroken overlong token at the overflow char', () => {
    const lines = breakLines([run('abcdefghijklmno')], FakeMetrics, maxWidth)
    expect(lines.map((l) => [l.start, l.end])).toEqual([
      [0, 10],
      [10, 15],
    ])
  })
})
