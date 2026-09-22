import { describe, expect, it } from 'vitest'
import { createLayoutEngine } from '../src/index.js'
import { FakeMetrics } from './fake-metrics.js'
import type { LayoutOptions, SemanticDoc, TextStyle } from '../src/index.js'

const style: TextStyle = { fontFamily: 'sans-serif', fontSize: 16 }
const baseStyle: TextStyle = { fontFamily: 'sans-serif', fontSize: 16 }

// Letter page, 96px margins → contentBox 624 (62 chars at 10px).
const opts: LayoutOptions = {
  page: { width: 816, height: 1056 },
  margins: { top: 96, right: 96, bottom: 96, left: 96 },
}

describe('createLayoutEngine (M1 measured layout)', () => {
  it('wraps a paragraph into stacked, measured line boxes', () => {
    // 20 words, single spaces: 99 chars. 62 fit per line, so the greedy
    // breaker splits after word 12 ("word" x12 = 59 chars) and trims the
    // break space; the remaining 8 words (39 chars) form line 2.
    const text = Array.from({ length: 20 }, (_, i) => (i === 0 ? 'word' : ' word')).join('')
    const doc: SemanticDoc = {
      baseStyle,
      blocks: [
        { id: 'p1', kind: 'paragraph', runs: [{ text, style }] },
        { id: 'p2', kind: 'paragraph', runs: [{ text: 'hi', style }] },
      ],
    }

    const { layout } = createLayoutEngine({ metrics: FakeMetrics })
    const result = layout(doc, opts)

    expect(result.lines).toHaveLength(3)
    const [line0, line1, line2] = result.lines

    expect(line0.blockId).toBe('p1')
    expect(line0.lineIndex).toBe(0)
    expect(line0.rangeStart).toBe(0)
    expect(line0.rangeEnd).toBe(59)
    expect(line0.segments).toEqual([{ runIndex: 0, start: 0, end: 59 }])
    expect(line0.rect).toMatchObject({ x: 0, y: 0 })
    expect(line0.rect.width).toBe(590)
    expect(line0.rect.height).toBeCloseTo(17.6)
    expect(line0.baseline).toBeCloseTo(13.6)

    expect(line1.blockId).toBe('p1')
    expect(line1.lineIndex).toBe(1)
    expect(line1.rangeStart).toBe(60)
    expect(line1.rangeEnd).toBe(99)
    expect(line1.rect.width).toBe(390)
    // Stacked directly under line 0 (tight, no leading in M1).
    expect(line1.rect.y).toBeCloseTo(17.6)
    expect(line1.rect.height).toBeCloseTo(17.6)

    // Cross-block stacking: block 2's first line starts at block 1's
    // last-line bottom.
    expect(line2.blockId).toBe('p2')
    expect(line2.lineIndex).toBe(0)
    expect(line2.rangeStart).toBe(0)
    expect(line2.rangeEnd).toBe(2)
    expect(line2.rect.y).toBeCloseTo(line1.rect.y + line1.rect.height)
    expect(line2.rect.y).toBeCloseTo(35.2)
  })

  it('gives an empty paragraph a baseStyle-measured placeholder line', () => {
    // Fulfilled by M2 baseStyle: a line with no runs falls back to the
    // document baseStyle (REQUIRED, supplied by the adapter — defaults
    // live at the edges, never in the engine) for height/baseline.
    // Width stays 0 (no glyphs). This test pins the behavior.
    const doc: SemanticDoc = { baseStyle, blocks: [{ id: 'p1', kind: 'paragraph', runs: [] }] }

    const { layout } = createLayoutEngine({ metrics: FakeMetrics })
    const result = layout(doc, opts)

    expect(result.lines).toHaveLength(1)
    expect(result.lines[0]).toMatchObject({
      blockId: 'p1',
      lineIndex: 0,
      pageIndex: 0,
      rangeStart: 0,
      rangeEnd: 0,
      segments: [],
    })
    expect(result.lines[0].baseline).toBeCloseTo(13.6)
    expect(result.lines[0].rect).toMatchObject({ x: 0, y: 0, width: 0 })
    expect(result.lines[0].rect.height).toBeCloseTo(17.6)
  })
})
