import { describe, expect, it } from 'vitest'
import { createLayoutEngine } from '../src/index.js'
import { FakeMetrics } from './fake-metrics.js'
import type { LayoutOptions, LineBox, SemanticDoc, TextStyle } from '../src/index.js'

// BLOCK-LEVEL INDENT FAMILY — indentLeft, indentRight,
// firstLineIndent: block geometry, never run styles. Base lines wrap
// at contentBox.width − indentLeft − indentRight and sit at rect.x =
// indentLeft; ONLY lineIndex 0 gets the edge indentLeft +
// firstLineIndent and wraps at its own width (firstLineIndent may be
// NEGATIVE under a larger indentLeft — the hanging style). The
// family is hash-covered, and a negative computed left edge THROWS
// (loud seam). Letter, 96 margins → contentBox 624×864. fontSize 100
// → ascent 85 + descent 25 = 110px lines → cap = 7 (864/110 = 7.85).
const style: TextStyle = { fontFamily: 'sans-serif', fontSize: 100 }
const baseStyle: TextStyle = { fontFamily: 'sans-serif', fontSize: 16 }
const opts: LayoutOptions = {
  page: { width: 816, height: 1056 },
  margins: { top: 96, right: 96, bottom: 96, left: 96 },
}

// "aaaa " = 50px/token at 10px/char; the breaker trims the space at a
// break, so a mid-block N-token line measures 50N−10. Unindented: 12
// tokens/line (600 ≤ 624). indentLeft 120 → wrap 504 → 10 tokens/line
// (500 ≤ 504, 550 > 504).
function para(
  id: string,
  tokens: number,
  extra: { indentLeft?: number; indentRight?: number; firstLineIndent?: number } = {},
) {
  return {
    id,
    kind: 'paragraph' as const,
    runs: [{ text: 'aaaa '.repeat(tokens), style }],
    ...(extra.indentLeft != null ? { indentLeft: extra.indentLeft } : {}),
    ...(extra.indentRight != null ? { indentRight: extra.indentRight } : {}),
    ...(extra.firstLineIndent != null ? { firstLineIndent: extra.firstLineIndent } : {}),
  }
}

const layout = (doc: SemanticDoc, o: LayoutOptions = opts) =>
  createLayoutEngine({ metrics: FakeMetrics }).layout(doc, o)

const byBlock = (result: { lines: LineBox[] }, id: string) =>
  result.lines.filter((l) => l.blockId === id)

describe('block-level indent geometry (indentLeft)', () => {
  it('1. indent shifts rect.x AND the wrap width together', () => {
    // 20 tokens: unindented wraps 12+8; indent 120 narrows the wrap
    // to 504 → 10+10. BOTH halves of the shift are visible: rect.x
    // 120 and per-line widths that only the narrower wrap produces.
    const control = layout({ baseStyle, blocks: [para('a', 20)] })
    expect(byBlock(control, 'a').map((l) => [l.rect.x, l.rect.width])).toEqual([
      [0, 590],
      [0, 400],
    ])

    const indented = layout({ baseStyle, blocks: [para('a', 20, { indentLeft: 120 })] })
    const a = byBlock(indented, 'a')
    expect(a).toHaveLength(2)
    expect(a.map((l) => [l.rect.x, l.rect.width])).toEqual([
      [120, 490],
      [120, 500],
    ])
  })

  it('2. fragment continuation across a page boundary preserves indentLeft on both fragments', () => {
    // 100 tokens at wrap 504 = 10 lines × 10 tokens; cap 7 → split
    // 7+3. The continuation page's lines keep rect.x = 120 AND the
    // narrowed wrap (their widths come from the same 504 wrap).
    const result = layout({ baseStyle, blocks: [para('tall', 100, { indentLeft: 120 })] })
    const tall = byBlock(result, 'tall')
    expect(tall).toHaveLength(10)
    expect(result.breaks).toEqual([{ blockId: 'tall', atLine: 7, pageIndex: 1 }])
    expect(tall.map((l) => [l.pageIndex, l.rect.x, l.rect.width])).toEqual([
      [0, 120, 490],
      [0, 120, 490],
      [0, 120, 490],
      [0, 120, 490],
      [0, 120, 490],
      [0, 120, 490],
      [0, 120, 490],
      [1, 120, 490],
      [1, 120, 490],
      [1, 120, 500],
    ])
    expect(tall[7].rect.y).toBe(0) // continuation at a bare page top
  })

  it('3. indentLeft is hash-covered: an indent-only edit re-breaks and re-places', () => {
    // Same engine, warm cache: changing ONLY indentLeft must miss the
    // contentHash and re-place the block (shifted x, narrowed wrap).
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const docA: SemanticDoc = { baseStyle, blocks: [para('a', 20)] }
    const docB: SemanticDoc = { baseStyle, blocks: [para('a', 20, { indentLeft: 120 })] }

    const first = engine.layout(docA, opts)
    const second = engine.layout(docB, opts) // warm; hash must miss
    const cold = layout(docB)

    expect(first.lines[0].rect.x).toBe(0)
    expect(second.lines[0].rect.x).toBe(120)
    expect(second.lines).toEqual(cold.lines) // warm == cold (parity)
  })

  it('4. headings route through the same indent geometry (kind-agnostic)', () => {
    const result = layout({
      baseStyle,
      blocks: [
        {
          id: 'h',
          kind: 'heading',
          level: 2,
          runs: [{ text: 'aaaa '.repeat(20), style }],
          indentLeft: 120,
        },
      ],
    })
    const h = byBlock(result, 'h')
    expect(h.map((l) => [l.rect.x, l.rect.width])).toEqual([
      [120, 490],
      [120, 500],
    ])
  })

  it('5. absent ≡ explicit 0: no indent is a plain x-0 layout', () => {
    const absent = layout({ baseStyle, blocks: [para('a', 12)] })
    const zero = layout({ baseStyle, blocks: [para('a', 12, { indentLeft: 0 })] })
    expect(absent.lines).toEqual(zero.lines)
    expect(zero.lines[0].rect.x).toBe(0)
  })
})

describe('indent family: indentRight + firstLineIndent', () => {
  it('1. indentRight narrows the wrap width; rect.x stays at indentLeft; widths match the narrower wrap', () => {
    // 20 tokens, indentRight 124 → wrap 624−124 = 500 → 10+10
    // tokens (control: 12+8 at wrap 624). Combined with indentLeft 40
    // the same narrowing happens with rect.x pinned at 40.
    const control = layout({ baseStyle, blocks: [para('a', 20)] })
    expect(byBlock(control, 'a').map((l) => [l.rangeStart, l.rangeEnd, l.rect.x, l.rect.width])).toEqual([
      [0, 59, 0, 590],
      [60, 100, 0, 400],
    ])

    const right = layout({ baseStyle, blocks: [para('b', 20, { indentRight: 124 })] })
    expect(byBlock(right, 'b').map((l) => [l.rangeStart, l.rangeEnd, l.rect.x, l.rect.width])).toEqual([
      [0, 49, 0, 490],
      [50, 100, 0, 500],
    ])

    const both = layout({
      baseStyle,
      blocks: [para('c', 20, { indentLeft: 40, indentRight: 84 })],
    })
    expect(byBlock(both, 'c').map((l) => [l.rect.x, l.rect.width])).toEqual([
      [40, 490],
      [40, 500],
    ])
  })

  it('2. firstLineIndent positive: line 0 sits at indentLeft + fli and breaks at its own width', () => {
    // fli 100 → line 0 wraps at 524 (10 tokens), lines 1+ at 624.
    // Control (no fli): 12+8. Line 0: x 100, w 490; line 1: x 0, w 500.
    const result = layout({ baseStyle, blocks: [para('a', 20, { firstLineIndent: 100 })] })
    expect(byBlock(result, 'a').map((l) => [l.rangeStart, l.rangeEnd, l.rect.x, l.rect.width])).toEqual([
      [0, 49, 100, 490],
      [50, 100, 0, 500],
    ])
  })

  it('3. hanging indent: indentLeft 64 + firstLineIndent −64 → line 0 out at 0, wrapped lines in at 64', () => {
    // Line 0 wraps at 624−64+64 = 624 (12 tokens); lines 1+ wrap at
    // 560 (11 tokens) and sit at x 64 — the bibliography/legal shape.
    const result = layout({
      baseStyle,
      blocks: [para('h', 30, { indentLeft: 64, firstLineIndent: -64 })],
    })
    expect(byBlock(result, 'h').map((l) => [l.rangeStart, l.rangeEnd, l.rect.x, l.rect.width])).toEqual([
      [0, 59, 0, 590],
      [60, 114, 64, 540],
      [115, 150, 64, 350],
    ])
  })

  it('4. fragment continuation: first-line indent applies ONCE at the true start, never on page-2 fragments', () => {
    // fli 50: line 0 wraps at 574 (x 50); lines 1+ wrap at 624 (x 0).
    // 10 lines → split 7+3; the continuation page's lines resume at
    // the BASE edge (0), never re-applying the first-line indent.
    const result = layout({ baseStyle, blocks: [para('tall', 119, { firstLineIndent: 50 })] })
    const tall = byBlock(result, 'tall')
    expect(tall).toHaveLength(10)
    expect(result.breaks).toEqual([{ blockId: 'tall', atLine: 7, pageIndex: 1 }])
    expect(tall.map((l) => [l.pageIndex, l.rect.x, l.rect.width])).toEqual([
      [0, 50, 540],
      [0, 0, 590],
      [0, 0, 590],
      [0, 0, 590],
      [0, 0, 590],
      [0, 0, 590],
      [0, 0, 590],
      [1, 0, 590],
      [1, 0, 590],
      [1, 0, 600],
    ])
    expect(tall[7].rect.y).toBe(0) // continuation at a bare page top, base indent
  })

  it('5. fragment continuation preserves indentRight on both fragments', () => {
    // indentRight 124 → wrap 500 for EVERY line of EVERY fragment.
    // 80 tokens → 8 lines (7×10 + final 10) → cap 7 → R3 widow backs
    // the split to 6+2; page-2 lines keep the same narrow wrap.
    const result = layout({ baseStyle, blocks: [para('tall', 80, { indentRight: 124 })] })
    const tall = byBlock(result, 'tall')
    expect(tall).toHaveLength(8)
    expect(result.breaks).toEqual([{ blockId: 'tall', atLine: 6, pageIndex: 1 }])
    expect(tall.map((l) => [l.pageIndex, l.rect.x, l.rect.width])).toEqual([
      [0, 0, 490],
      [0, 0, 490],
      [0, 0, 490],
      [0, 0, 490],
      [0, 0, 490],
      [0, 0, 490],
      [1, 0, 490],
      [1, 0, 500],
    ])
    expect(tall[6].rect.y).toBe(0)
  })

  it('6. negative computed left edge THROWS, naming both values (loud seam)', () => {
    // indentLeft 32 + firstLineIndent −64 → line 0 would start at
    // −32, left of the content box: refused loudly, no clipping.
    const doc = {
      baseStyle,
      blocks: [para('bad', 12, { indentLeft: 32, firstLineIndent: -64 })],
    }
    expect(() => layout(doc)).toThrow(/indentLeft 32 \+ firstLineIndent -64 = -32 < 0/)
    expect(() => layout(doc)).toThrow(/adapter must validate/)
  })

  it('7. indentRight is hash-covered: a right-indent-only edit re-breaks and re-places', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const docA: SemanticDoc = { baseStyle, blocks: [para('a', 20)] }
    const docB: SemanticDoc = { baseStyle, blocks: [para('a', 20, { indentRight: 124 })] }

    const first = engine.layout(docA, opts)
    const second = engine.layout(docB, opts) // warm; hash must miss
    const cold = layout(docB)

    expect(first.lines[0].rect.width).toBe(590)
    expect(second.lines[0].rect.width).toBe(490) // re-broke narrower
    expect(second.lines).toEqual(cold.lines) // warm == cold (parity)
  })

  it('8. firstLineIndent is hash-covered: an fli-only edit re-breaks and re-places', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const docA: SemanticDoc = { baseStyle, blocks: [para('a', 20)] }
    const docB: SemanticDoc = { baseStyle, blocks: [para('a', 20, { firstLineIndent: 100 })] }

    const first = engine.layout(docA, opts)
    const second = engine.layout(docB, opts) // warm; hash must miss
    const cold = layout(docB)

    expect(first.lines[0].rect.x).toBe(0)
    expect(second.lines[0].rect.x).toBe(100) // re-placed at the fli edge
    expect(second.lines).toEqual(cold.lines) // warm == cold (parity)
  })
})
