import { describe, expect, it } from 'vitest'
import { createLayoutEngine } from '../src/index.js'
import { FakeMetrics } from './fake-metrics.js'
import type { FlowPolicy, LayoutOptions, SemanticDoc, TextStyle } from '../src/index.js'

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
function para(id: string, lines: number, flow?: FlowPolicy) {
  return {
    id,
    kind: 'paragraph' as const,
    runs: [{ text: 'aaaa '.repeat(12 * lines), style }],
    ...(flow ? { flow } : {}),
  }
}

const layout = (doc: SemanticDoc, o: LayoutOptions = opts) =>
  createLayoutEngine({ metrics: FakeMetrics }).layout(doc, o)

const lineIndicesOn = (result: { lines: { pageIndex: number; lineIndex: number }[] }, p: number) =>
  result.lines.filter((l) => l.pageIndex === p).map((l) => l.lineIndex)

describe('slicer (M2 pages, FragmentBreaks, widows, orphans)', () => {
  it('1. NATURAL SPLIT: a 10-line block flows 7 + 3 across two pages', () => {
    const doc: SemanticDoc = { baseStyle, blocks: [para('p1', 10)] }
    const result = layout(doc)

    expect(result.pages).toHaveLength(2)
    expect(result.breaks).toEqual([{ blockId: 'p1', atLine: 7, pageIndex: 1 }])
    expect(lineIndicesOn(result, 0)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(lineIndicesOn(result, 1)).toEqual([7, 8, 9])
    // y restarts at the top of each page's content box.
    const firstOnPage1 = result.lines.find((l) => l.pageIndex === 1)!
    expect(firstOnPage1.rect.y).toBe(0)
  })

  it('2. ORPHAN PUSH: a 5-line block after a 6-line filler starts page 1 intact', () => {
    const doc: SemanticDoc = { baseStyle, blocks: [para('fill', 6), para('p2', 5)] }
    const result = layout(doc)

    expect(result.pages).toHaveLength(2)
    // A block pushed wholly to a new page emits NO FragmentBreak.
    expect(result.breaks).toEqual([])
    const page0 = result.lines.filter((l) => l.pageIndex === 0)
    expect(page0).toHaveLength(6)
    expect(page0.every((l) => l.blockId === 'fill')).toBe(true)
    const page1 = result.lines.filter((l) => l.pageIndex === 1)
    expect(page1.map((l) => [l.blockId, l.lineIndex])).toEqual([
      ['p2', 0],
      ['p2', 1],
      ['p2', 2],
      ['p2', 3],
      ['p2', 4],
    ])
  })

  it('3. WIDOW ADJUST: a 5-line block after a 3-line filler splits 3/2, not 4/1', () => {
    const doc: SemanticDoc = { baseStyle, blocks: [para('fill', 3), para('p2', 5)] }
    const result = layout(doc)

    expect(result.breaks).toEqual([{ blockId: 'p2', atLine: 3, pageIndex: 1 }])
    const block = (p: number) =>
      result.lines.filter((l) => l.blockId === 'p2' && l.pageIndex === p).map((l) => l.lineIndex)
    expect(block(0)).toEqual([0, 1, 2])
    expect(block(1)).toEqual([3, 4])
  })

  it('4. EXEMPTION: a 15-line block (taller than a page) splits 7/6/2 with no lone last line', () => {
    const doc: SemanticDoc = { baseStyle, blocks: [para('p1', 15)] }
    const result = layout(doc)

    expect(result.pages).toHaveLength(3)
    expect(result.breaks).toEqual([
      { blockId: 'p1', atLine: 7, pageIndex: 1 },
      { blockId: 'p1', atLine: 13, pageIndex: 2 },
    ])
    expect(lineIndicesOn(result, 0)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(lineIndicesOn(result, 1)).toEqual([7, 8, 9, 10, 11, 12])
    expect(lineIndicesOn(result, 2)).toEqual([13, 14])
  })

  it('5. TOGGLE: preventWidowsAndOrphans: false reverts case 3 to the natural 4/1', () => {
    const doc: SemanticDoc = { baseStyle, blocks: [para('fill', 3), para('p2', 5)] }
    const result = layout(doc, { ...opts, preventWidowsAndOrphans: false })

    expect(result.breaks).toEqual([{ blockId: 'p2', atLine: 4, pageIndex: 1 }])
    const block = (p: number) =>
      result.lines.filter((l) => l.blockId === 'p2' && l.pageIndex === p).map((l) => l.lineIndex)
    expect(block(0)).toEqual([0, 1, 2, 3])
    expect(block(1)).toEqual([4])
  })

  it('6. CONTINUITY: case 1 keeps lineIndex 0..9 gapless with correct pageIndex', () => {
    const doc: SemanticDoc = { baseStyle, blocks: [para('p1', 10)] }
    const result = layout(doc)

    expect(result.lines.map((l) => l.lineIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(result.lines.map((l) => l.pageIndex)).toEqual([0, 0, 0, 0, 0, 0, 0, 1, 1, 1])
  })

  it('7. ATOMIC: a 5-line keepLines block after a 6-line filler lands intact on page 1', () => {
    const doc: SemanticDoc = {
      baseStyle,
      blocks: [para('fill', 6), para('p2', 5, { keepLines: true })],
    }
    const result = layout(doc)

    expect(result.breaks).toEqual([])
    const page1 = result.lines.filter((l) => l.pageIndex === 1)
    expect(page1.map((l) => l.lineIndex)).toEqual([0, 1, 2, 3, 4])
    expect(page1.every((l) => l.blockId === 'p2')).toBe(true)
  })

  it('7b. ATOMIC (discriminating): keepLines moves the block whole where orphan control alone would split 3/2', () => {
    // After a 4-line filler, fits = 3 for a 5-line block: widow control
    // does not fire (n - fits = 2), so WITHOUT keepLines this splits 3/2
    // with a FragmentBreak — keepLines must move it intact instead.
    const doc: SemanticDoc = {
      baseStyle,
      blocks: [para('fill', 4), para('p2', 5, { keepLines: true })],
    }
    const result = layout(doc)

    expect(result.breaks).toEqual([])
    const page1 = result.lines.filter((l) => l.pageIndex === 1)
    expect(page1.map((l) => l.lineIndex)).toEqual([0, 1, 2, 3, 4])
    expect(page1.every((l) => l.blockId === 'p2')).toBe(true)

    // Sanity: the twin without keepLines splits 3/2.
    const twin = layout({ baseStyle, blocks: [para('fill', 4), para('p2', 5)] })
    expect(twin.breaks).toEqual([{ blockId: 'p2', atLine: 3, pageIndex: 1 }])
  })

  it('8. PER-BLOCK WIDOW OFF: flow.widowControl: false reverts case 3 to the natural 4/1', () => {
    const doc: SemanticDoc = {
      baseStyle,
      blocks: [para('fill', 3), para('p2', 5, { widowControl: false })],
    }
    const result = layout(doc)

    expect(result.breaks).toEqual([{ blockId: 'p2', atLine: 4, pageIndex: 1 }])
    const block = (p: number) =>
      result.lines.filter((l) => l.blockId === 'p2' && l.pageIndex === p).map((l) => l.lineIndex)
    expect(block(0)).toEqual([0, 1, 2, 3])
    expect(block(1)).toEqual([4])
  })

  it('9. LOUD SEAMS: M2.5 flow fields throw; null counts as unset', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const docWith = (flow: unknown) =>
      ({ baseStyle, blocks: [para('p1', 1, flow as FlowPolicy)] }) as SemanticDoc

    expect(() => engine.layout(docWith({ keepNext: true }), opts)).toThrow('not yet implemented')
    expect(() => engine.layout(docWith({ breakBefore: 'page' }), opts)).toThrow('not yet implemented')

    // PM attribute JSON round-trips use null for absent attrs: a .tensor
    // file with flow: { keepNext: null } must not throw on load — null
    // is normalized to UNSET.
    expect(() =>
      engine.layout(
        docWith({ keepNext: null, keepPrevious: null, breakBefore: null, breakAfter: null }),
        opts,
      ),
    ).not.toThrow()

    // Booleans' default semantics are harmless: false never throws
    // (throw is "if true").
    expect(() =>
      engine.layout(docWith({ keepNext: false, keepPrevious: false }), opts),
    ).not.toThrow()
  })

  it('10. TALL ORPHAN: a 10-line block after a 6-line filler moves its start to page 1, then fragments 7/3', () => {
    const doc: SemanticDoc = { baseStyle, blocks: [para('fill', 6), para('p2', 10)] }
    const result = layout(doc)

    expect(result.pages).toHaveLength(3)
    // Page 0 holds ONLY the filler — no orphan stub, one line of space
    // sacrificed at the bottom.
    const page0 = result.lines.filter((l) => l.pageIndex === 0)
    expect(page0).toHaveLength(6)
    expect(page0.every((l) => l.blockId === 'fill')).toBe(true)
    expect(lineIndicesOn(result, 1)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(lineIndicesOn(result, 2)).toEqual([7, 8, 9])
    expect(result.breaks).toEqual([{ blockId: 'p2', atLine: 7, pageIndex: 2 }])
    // NOT {atLine: 1} — the start moved whole, it did not fragment at 1.
    expect(result.breaks.some((b) => b.atLine === 1)).toBe(false)
  })

  it('11. TALL WIDOW: an 8-line block (cap + 1) splits 6/2, keeping its last two lines together', () => {
    const doc: SemanticDoc = { baseStyle, blocks: [para('p1', 8)] }
    const result = layout(doc)

    expect(result.pages).toHaveLength(2)
    expect(result.breaks).toEqual([{ blockId: 'p1', atLine: 6, pageIndex: 1 }])
    expect(lineIndicesOn(result, 0)).toEqual([0, 1, 2, 3, 4, 5])
    expect(lineIndicesOn(result, 1)).toEqual([6, 7])
  })

  it('12. PINNED DEGENERATE CORNER: at cap == 2 the widow is fixed and the orphan deliberately sacrificed', () => {
    // Page 300×412, margins 96 → contentBox 108×220 → cap == 2 (110px
    // lines). A 3-line block: both boundary minimums are unsatisfiable —
    // fixing the widow (break at 1) leaves the block's first line alone
    // at the page bottom. The widow is fixed and the orphan deliberately
    // sacrificed, because loop-freedom and determinism outrank a
    // minimum that cannot be honored; the y > 0 guard makes moving
    // vacuous. Pinned so any change to this corner shows up as a
    // deliberate red → green, not silent drift.
    const tinyOpts: LayoutOptions = {
      page: { width: 300, height: 412 },
      margins: { top: 96, right: 96, bottom: 96, left: 96 },
    }
    // Content width 108 → 2 "aaaa " tokens per line; 6 tokens = 3 lines.
    const doc: SemanticDoc = {
      baseStyle,
      blocks: [
        { id: 'p1', kind: 'paragraph', runs: [{ text: 'aaaa '.repeat(6), style }] },
      ],
    }
    const result = layout(doc, tinyOpts)

    expect(result.pages).toHaveLength(2)
    expect(result.breaks).toEqual([{ blockId: 'p1', atLine: 1, pageIndex: 1 }])
    const page0 = result.lines.filter((l) => l.pageIndex === 0)
    expect(page0).toHaveLength(1) // EXACTLY ONE line — the sacrificed orphan
    expect(page0[0].lineIndex).toBe(0)
    expect(lineIndicesOn(result, 1)).toEqual([1, 2])
  })
})
