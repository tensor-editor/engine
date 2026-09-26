import { describe, expect, it } from 'vitest'
import { createLayoutEngine } from '../src/index.js'
import { FakeMetrics } from './fake-metrics.js'
import type { FlowPolicy, LayoutOptions, SemanticDoc, TextStyle } from '../src/index.js'

// BLOCK-TIER SPACING (M6): spaceBefore/spaceAtExit walk semantics.
// Letter, 96 margins → contentBox 624×864. fontSize 100 →
// ascent 85 + descent 25 = 110px lines → cap = 7 (864/110 = 7.85).
const style: TextStyle = { fontFamily: 'sans-serif', fontSize: 100 }
const baseStyle: TextStyle = { fontFamily: 'sans-serif', fontSize: 16 }
const opts: LayoutOptions = {
  page: { width: 816, height: 1056 },
  margins: { top: 96, right: 96, bottom: 96, left: 96 },
}

// "aaaa " = 50px/token at 10px/char; the 624px content width holds 12
// tokens (600px) per line, so an N-line block = 12×N tokens.
function para(
  id: string,
  lines: number,
  extra: { spaceBefore?: number; spaceAfter?: number; flow?: FlowPolicy } = {},
) {
  return {
    id,
    kind: 'paragraph' as const,
    runs: [{ text: 'aaaa '.repeat(12 * lines), style }],
    ...(extra.flow ? { flow: extra.flow } : {}),
    ...(extra.spaceBefore != null ? { spaceBefore: extra.spaceBefore } : {}),
    ...(extra.spaceAfter != null ? { spaceAfter: extra.spaceAfter } : {}),
  }
}

const layout = (doc: SemanticDoc, o: LayoutOptions = opts) =>
  createLayoutEngine({ metrics: FakeMetrics }).layout(doc, o)

const byBlock = (result: { lines: { blockId: string; pageIndex: number; rect: { y: number } }[] }, id: string) =>
  result.lines.filter((l) => l.blockId === id)

describe('block-tier spacing (spaceBefore/spaceAfter)', () => {
  it('1. spaceBefore pushes the block: first-line top sits below it', () => {
    const result = layout({ baseStyle, blocks: [para('fill', 3), para('b', 2, { spaceBefore: 100 })] })
    // fill ends at y 330; spaceBefore 100 → b's first line top at 430.
    const b = byBlock(result, 'b')
    expect(b[0].pageIndex).toBe(0)
    expect(b[0].rect.y).toBe(330 + 100)
  })

  it('2. spaceBefore participates in fits: a no-longer-fitting block moves whole', () => {
    // fill(6) ends at 660, budget 204. Without spaceBefore one 110px
    // line fits (natural 1+1 fragment under widowControl:false);
    // WITH spaceBefore 100 the budget is 104 < 110 → fits == 0 → R1
    // moves the whole block — spaceBefore pushed it across the page.
    const control = layout({
      baseStyle,
      blocks: [para('fill', 6), para('b', 2, { flow: { widowControl: false } })],
    })
    expect(control.breaks).toEqual([{ blockId: 'b', atLine: 1, pageIndex: 1 }])

    const spaced = layout({
      baseStyle,
      blocks: [para('fill', 6), para('b', 2, { flow: { widowControl: false }, spaceBefore: 100 })],
    })
    expect(spaced.breaks).toEqual([]) // moved whole, no fragment
    expect(byBlock(spaced, 'b').every((l) => l.pageIndex === 1)).toBe(true)
  })

  it('3. spaceAfter joins the exit cursor: the next block starts below it', () => {
    const result = layout({ baseStyle, blocks: [para('a', 1, { spaceAfter: 50 }), para('b', 1)] })
    expect(byBlock(result, 'b')[0].rect.y).toBe(110 + 50)
  })

  it('4. spaceAfter participates in the NEXT block’s fits', () => {
    // fill(6)+spaceAfter 100 ends at 760, budget 104 < 110 → R1: the
    // successor (natural-split control case) now moves whole.
    const control = layout({
      baseStyle,
      blocks: [para('fill', 6), para('c', 2, { flow: { widowControl: false } })],
    })
    expect(control.breaks).toEqual([{ blockId: 'c', atLine: 1, pageIndex: 1 }])

    const spaced = layout({
      baseStyle,
      blocks: [para('fill', 6, { spaceAfter: 100 }), para('c', 2, { flow: { widowControl: false } })],
    })
    expect(spaced.breaks).toEqual([])
    expect(byBlock(spaced, 'c').every((l) => l.pageIndex === 1)).toBe(true)
  })

  it('5. fragment continuation does NOT re-apply spaceBefore', () => {
    // Fresh page: spaceBefore 95 consumed at entry → first line top
    // at 95; 6 lines fit (95+6×110 = 755; a 7th would end 865 > 864)
    // → fragment; the continuation page starts at a BARE page top.
    const result = layout({ baseStyle, blocks: [para('tall', 10, { spaceBefore: 95 })] })
    const tall = byBlock(result, 'tall')
    expect(tall).toHaveLength(10)
    expect(result.breaks).toEqual([{ blockId: 'tall', atLine: 6, pageIndex: 1 }])
    expect(tall[0].rect.y).toBe(95)
    expect(tall[6].pageIndex).toBe(1)
    expect(tall[6].rect.y).toBe(0) // no spaceBefore on the continuation
  })

  it('6. a start-move (R1/R2) does not re-apply spaceBefore either', () => {
    // Same page-1 top after an orphan push: the spaceBefore was
    // consumed at entry on page 0 and is not re-paid on the move.
    const result = layout({ baseStyle, blocks: [para('fill', 6), para('b', 4, { spaceBefore: 100 })] })
    const b = byBlock(result, 'b')
    expect(b.every((l) => l.pageIndex === 1)).toBe(true)
    expect(b[0].rect.y).toBe(0)
  })

  it('7. orphan evaluates against line tops accounting for spaceBefore', () => {
    // fill(5) ends at 550, budget 314: without spaceBefore two lines
    // fit (220 ≤ 314) → natural 2+2 fragment. WITH spaceBefore 100
    // the budget is 214 → fits == 1 → the orphan rule moves the whole
    // block to page 1 — the decision accounted for spaceBefore.
    const control = layout({
      baseStyle,
      blocks: [para('fill', 5), para('d', 4)],
    })
    expect(control.breaks).toEqual([{ blockId: 'd', atLine: 2, pageIndex: 1 }])

    const spaced = layout({
      baseStyle,
      blocks: [para('fill', 5), para('d', 4, { spaceBefore: 100 })],
    })
    expect(spaced.breaks).toEqual([])
    expect(byBlock(spaced, 'd').every((l) => l.pageIndex === 1)).toBe(true)
  })

  it('8. spaceBefore is not content: a fresh page is never closed for it (R6)', () => {
    // spaceBefore 800 on a fresh page leaves a 64px budget — no line
    // fits, but the page holds no line tops, so R1 must NOT close it
    // (never-empty-page). R6 places the first line by fiat (over-
    // flowing, pinned), the fragment continues on the next page —
    // WITHOUT spaceBefore.
    const result = layout({ baseStyle, blocks: [para('b', 3, { spaceBefore: 800 })] })
    const b = byBlock(result, 'b')
    expect(result.pages).toHaveLength(2)
    expect(b[0].pageIndex).toBe(0)
    expect(b[0].rect.y).toBe(800) // R6 fiat line, top at spaceBefore
    expect(b[1].pageIndex).toBe(1)
    expect(b[1].rect.y).toBe(0)
    expect(result.breaks).toEqual([{ blockId: 'b', atLine: 1, pageIndex: 1 }])
  })

  it('9. spaceBefore/spaceAfter are hash-covered: a spacing edit re-places', () => {
    // Same engine, warm cache: changing ONLY spaceBefore must miss
    // the contentHash and re-place the block (different line tops).
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const docA: SemanticDoc = { baseStyle, blocks: [para('a', 2)] }
    const docB: SemanticDoc = { baseStyle, blocks: [para('a', 2, { spaceBefore: 60 })] }

    const first = engine.layout(docA, opts)
    const second = engine.layout(docB, opts) // warm; hash must miss
    const cold = layout(docB)

    expect(second.lines[0].rect.y).toBe(60)
    expect(second.lines).toEqual(cold.lines) // warm == cold (parity)
    expect(first.lines[0].rect.y).toBe(0)
  })
})
