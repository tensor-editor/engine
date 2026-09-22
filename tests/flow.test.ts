import { describe, expect, it } from 'vitest'
import { createLayoutEngine } from '../src/index.js'
import { FakeMetrics } from './fake-metrics.js'
import type { Block, FlowPolicy, LayoutOptions, SemanticDoc, TextStyle } from '../src/index.js'

// M2.5 FLOW POLICY: Word-exact boundary bonds, forced page breaks.
// FakeMetrics at fontSize 100 → 110px lines; Letter contentBox 624×864
// → cap = 7; 12 "aaaa " tokens (600px) per line.
const style16: TextStyle = { fontFamily: 'sans-serif', fontSize: 16 }
const style100: TextStyle = { fontFamily: 'sans-serif', fontSize: 100 }
const baseStyle: TextStyle = { fontFamily: 'sans-serif', fontSize: 16 }
const opts: LayoutOptions = {
  page: { width: 816, height: 1056 },
  margins: { top: 96, right: 96, bottom: 96, left: 96 },
}

const tokens = (lines: number) => 'aaaa '.repeat(12 * lines)

function para(id: string, lines: number, flow?: FlowPolicy, style: TextStyle = style100): Block {
  return {
    id,
    kind: 'paragraph',
    runs: [{ text: tokens(lines), style }],
    ...(flow ? { flow } : {}),
  }
}

function heading(id: string, lines: number, flow?: FlowPolicy): Block {
  return {
    id,
    kind: 'heading',
    level: 1,
    runs: [{ text: tokens(lines), style: style100 }],
    ...(flow ? { flow } : {}),
  }
}

const layout = (doc: SemanticDoc) => createLayoutEngine({ metrics: FakeMetrics }).layout(doc, opts)

const pagesOf = (result: { lines: { pageIndex: number }[] }) => result.lines.map((l) => l.pageIndex)
const pageLines = (result: { lines: { pageIndex: number; lineIndex: number }[] }, p: number) =>
  result.lines.filter((l) => l.pageIndex === p).map((l) => l.lineIndex)

describe('flow policy (M2.5): headings, bonds, forced breaks', () => {
  it('STEP 1: a heading-only doc lays out with real lines', () => {
    const result = layout({ baseStyle, blocks: [heading('h', 1)] })
    expect(result.pages).toHaveLength(1)
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0]).toMatchObject({
      blockId: 'h',
      lineIndex: 0,
      pageIndex: 0,
      rangeStart: 0,
      rangeEnd: 60,
    })
    expect(result.lines[0].rect.height).toBeCloseTo(110)
    expect(result.lines[0].baseline).toBeCloseTo(85)
  })

  it('STEP 1: a heading and a paragraph stack in document order', () => {
    const result = layout({ baseStyle, blocks: [heading('h', 1), para('p', 1)] })
    expect(result.lines.map((l) => l.blockId)).toEqual(['h', 'p'])
    expect(result.lines[0].rect.y).toBe(0)
    expect(result.lines[1].rect.y).toBeCloseTo(110)
    expect(result.lines.every((l) => l.pageIndex === 0)).toBe(true)
    expect(result.breaks).toEqual([])
  })

  it('bond honored via keepNext (shape 1: A\'s start moves fresh)', () => {
    // After the 5-line filler, A (2 lines) fits, but B's first line
    // would not follow A on page 0 — the bond moves A's start to page 1
    // so A and B share it.
    const result = layout({ baseStyle, blocks: [para('f', 5), para('a', 2, { keepNext: true }), para('b', 2)] })
    expect(result.pages).toHaveLength(2)
    expect(pagesOf(result)).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 1])
    expect(result.breaks).toEqual([])
  })

  it('bond honored via keepPrevious (same bond, second spelling)', () => {
    const result = layout({ baseStyle, blocks: [para('f', 5), para('a', 2), para('b', 2, { keepPrevious: true })] })
    expect(result.pages).toHaveLength(2)
    expect(pagesOf(result)).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 1])
    expect(result.breaks).toEqual([])
  })

  it('bond shape 2 (tall A): the final split backs up one line to join B', () => {
    // A (9 lines, taller than a page) splits 7/2; B's 704px first line
    // cannot follow the 2-line fragment (644px left) — shape 2 backs
    // the split up: 7/1/1+B, and A's last line shares page 2 with B
    // (754px left — fits).
    const bigStyle: TextStyle = { fontFamily: 'sans-serif', fontSize: 640 }
    const b: Block = {
      id: 'b',
      kind: 'paragraph',
      runs: [{ text: 'aaaa', style: bigStyle }], // one 704px line
    }
    const result = layout({ baseStyle, blocks: [para('a', 9, { keepNext: true }), b] })
    expect(result.pages).toHaveLength(3)
    expect(result.breaks).toEqual([
      { blockId: 'a', atLine: 7, pageIndex: 1 },
      { blockId: 'a', atLine: 8, pageIndex: 2 },
    ])
    // A's last line and B's first line share page 2.
    const aLast = result.lines.find((l) => l.blockId === 'a' && l.lineIndex === 8)!
    const bFirst = result.lines.find((l) => l.blockId === 'b')!
    expect(aLast.pageIndex).toBe(2)
    expect(bFirst.pageIndex).toBe(2)
    expect(bFirst.rect.y).toBeCloseTo(110)
  })

  it('3-chain: enforcement cascades backward through the whole chain', () => {
    // F(5) fills page 0 to y=550. W+X fit after it, but Y's first line
    // cannot follow X at y=770 — X's bond moves X fresh; that
    // retro-violates W→X, so W moves too; W, X, Y re-flow together on
    // page 1.
    const result = layout({
      baseStyle,
      blocks: [
        para('f', 5),
        para('w', 1, { keepNext: true }),
        para('x', 1, { keepNext: true }),
        para('y', 2),
      ],
    })
    expect(result.pages).toHaveLength(2)
    expect(pagesOf(result)).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 1])
    expect(result.breaks).toEqual([])
  })

  it('chain taller than a page: the maximal SUFFIX of bonds is honored (drop earliest first)', () => {
    // W (7 lines) fills a fresh page exactly and starts the doc — the
    // W→X bond is violated but the shape-1 move is vacuous (y == 0), so
    // the EARLIEST bond drops. X re-flows fresh on page 1 and the
    // X→Y bond holds. "Tensor's pinned choice — Word's exact tie-break
    // here is undocumented; this is our spec of record."
    const result = layout({
      baseStyle,
      blocks: [para('w', 7, { keepNext: true }), para('x', 2, { keepNext: true }), para('y', 2)],
    })
    expect(result.pages).toHaveLength(2)
    expect(pageLines(result, 0)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(pageLines(result, 1)).toEqual([0, 1, 0, 1])
    expect(result.breaks).toEqual([])
  })

  it('forced breaks: breakBefore/breakAfter close pages; never an empty page', () => {
    // breakAfter(A) closes page 0; breakBefore(B) at a fresh page is a
    // no-op — a double close would emit an empty page 1.
    const both = layout({
      baseStyle,
      blocks: [para('a', 2, { breakAfter: 'page' }), para('b', 3, { breakBefore: 'page' })],
    })
    expect(both.pages).toHaveLength(2)
    expect(both.breaks).toEqual([])
    expect(both.lines.filter((l) => l.pageIndex === 0)).toHaveLength(2)
    expect(both.lines.filter((l) => l.pageIndex === 1)).toHaveLength(3)

    // breakBefore on a fresh page start: no-op.
    const first = layout({ baseStyle, blocks: [para('a', 2, { breakBefore: 'page' })] })
    expect(first.pages).toHaveLength(1)

    // breakAfter on the LAST block: the trailing close never
    // materializes a phantom page (pages derive from line pageIndexes).
    const last = layout({ baseStyle, blocks: [para('a', 2, { breakAfter: 'page' })] })
    expect(last.pages).toHaveLength(1)
  })

  it('breakBefore(B) beats the bond A→B: structural drop, A keeps page 0', () => {
    // A page that must start with B cannot also start with A's last
    // fragment — the bond drops at detection. Wrong enforcement would
    // move A onto B's page, leaving page 0 EMPTY — forbidden.
    const result = layout({
      baseStyle,
      blocks: [para('a', 2, { keepNext: true }), para('b', 3, { breakBefore: 'page' })],
    })
    expect(result.pages).toHaveLength(2)
    expect(result.breaks).toEqual([])
    expect(result.lines.filter((l) => l.pageIndex === 0)).toHaveLength(2) // page 0 NOT empty
    expect(result.lines.filter((l) => l.pageIndex === 1)).toHaveLength(3)
  })

  it('breakAfter(A) drops the bond A→B too (symmetric structural tier)', () => {
    // breakAfter closes the page at the same A→B boundary — the bond
    // drops, same ruling as breakBefore. (Enforcement would give ONE
    // page; the drop gives two.)
    const result = layout({
      baseStyle,
      blocks: [para('a', 2, { keepNext: true, breakAfter: 'page' }), para('b', 3)],
    })
    expect(result.pages).toHaveLength(2)
    expect(result.breaks).toEqual([])
    expect(result.lines.filter((l) => l.pageIndex === 0)).toHaveLength(2)
    expect(result.lines.filter((l) => l.pageIndex === 1)).toHaveLength(3)
  })

  it('edge no-ops: keepNext on the last block, keepPrevious on the first, null = unset', () => {
    // keepNext with no successor: no bond to form.
    const lastBlock = layout({ baseStyle, blocks: [para('a', 2, { keepNext: true })] })
    expect(lastBlock.pages).toHaveLength(1)
    expect(lastBlock.lines).toHaveLength(2)

    // keepPrevious with no predecessor: no bond to form.
    const firstBlock = layout({ baseStyle, blocks: [para('a', 2, { keepPrevious: true }), para('b', 2)] })
    expect(firstBlock.pages).toHaveLength(1)
    expect(firstBlock.lines).toHaveLength(4)

    // null counts as UNSET (PM attribute JSON round-trips use null for
    // absent attrs): keepNext: null forms no bond, so A stays at the
    // page-0 bottom and B naturally flows to page 1 — whereas a REAL
    // bond would move A to page 1 with B (page 0 = 5 lines).
    const doc: SemanticDoc = {
      baseStyle,
      blocks: [
        para('f', 5),
        para('a', 2, { keepNext: null } as unknown as FlowPolicy),
        para('b', 2),
      ],
    }
    const nullResult = layout(doc)
    expect(nullResult.pages).toHaveLength(2)
    expect(nullResult.lines.filter((l) => l.pageIndex === 0)).toHaveLength(7) // f + a
    expect(nullResult.lines.filter((l) => l.pageIndex === 1)).toHaveLength(2) // b alone
  })

  it('impossible-after-move: A fills a fresh page exactly → the bond drops', () => {
    // A (7 lines = 770px) starts the doc fresh; B's first line cannot
    // follow at y=770. A fits a fresh page but ALREADY starts one —
    // the move is vacuous, so the bond drops (same give-up family as
    // the y > 0 guard).
    const result = layout({ baseStyle, blocks: [para('a', 7, { keepNext: true }), para('b', 2)] })
    expect(result.pages).toHaveLength(2)
    expect(result.breaks).toEqual([])
    expect(pageLines(result, 0)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(pageLines(result, 1)).toEqual([0, 1])
  })

  it('COMPOSED — structural drop → widow re-fire: 6/2, never 7/1', () => {
    // A (8 lines, keepNext) naturally splits 7/1; B carries
    // breakBefore: 'page' — the bond drops at detection (structural
    // tier), and control returns to R3: the widow adjust re-fires on
    // A's natural 7/1 split → 6/2. The bug this pins: if the drop
    // does NOT hand control back to R3, you get 7/1 — A's line 7 alone
    // at the top of page 1 (a widow) AND the bond dropped — worst of
    // both. Distinguishable via breaks {atLine 6} vs {atLine 7} and
    // page counts 6/2/3 vs 7/1/3.
    const result = layout({
      baseStyle,
      blocks: [para('a', 8, { keepNext: true }), para('b', 3, { breakBefore: 'page' })],
    })
    expect(result.pages).toHaveLength(3)
    expect(result.breaks).toEqual([{ blockId: 'a', atLine: 6, pageIndex: 1 }])
    expect(pageLines(result, 0)).toEqual([0, 1, 2, 3, 4, 5]) // A lines 0–5
    expect(pageLines(result, 1)).toEqual([6, 7]) // A lines 6–7 (widow fixed)
    expect(pageLines(result, 2)).toEqual([0, 1, 2]) // B
  })

  it('COMPOSED — R2 re-fire after cascade → bounded drop: 1/6/3', () => {
    // F (1 line) leaves y=110; A (6 lines, keepNext) fits after it
    // (exit (0,770)); B's first line needs 880 > 864 → R1 → the bond
    // moves A fresh to page 1 (exit (1,660)); B re-enters (1,660):
    // fits == 1, n == 3 → R2 re-fires → B to page 2 → A already used
    // its one move → the bond drops. A stays per the (f) ruling — no
    // revert; the move was unproductive but deterministic. The bugs
    // this pins: unbounded re-move loops, a revert, or B left orphaned
    // mid-page-1 — all distinguishable from 1/6/3.
    const result = layout({
      baseStyle,
      blocks: [para('f', 1), para('a', 6, { keepNext: true }), para('b', 3)],
    })
    expect(result.pages).toHaveLength(3)
    expect(result.breaks).toEqual([])
    expect(result.lines.filter((l) => l.pageIndex === 0)).toHaveLength(1) // F
    expect(result.lines.filter((l) => l.pageIndex === 1)).toHaveLength(6) // A
    expect(result.lines.filter((l) => l.pageIndex === 2)).toHaveLength(3) // B
  })
})
