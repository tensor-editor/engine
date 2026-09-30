import { describe, expect, it } from 'vitest'
import { createLayoutEngine } from '../src/index.js'
import { FakeMetrics } from './fake-metrics.js'
import type { Block, BlockBase, LayoutOptions, SemanticDoc, TextStyle } from '../src/index.js'

// E-IMG-3 — anchored floats (v1: wrap NONE): zero flow presence, the
// anchor + (dx, dy) → page-box clamp derivation, the z echo, the bond
// loud seam, the anchor-fragment ruling, and the cache surfaces.
//
// Letter page 816×1056, margins 96 → contentBox 624×864, page box
// [0, 816] × [0, 1056] (FakeMetrics: 10px per char, fontSize-16 line
// = 17.6px, fontSize-100 line = 110px).

const style: TextStyle = { fontFamily: 'sans-serif', fontSize: 16 }
const baseStyle: TextStyle = { fontFamily: 'sans-serif', fontSize: 16 }
const opts: LayoutOptions = {
  page: { width: 816, height: 1056 },
  margins: { top: 96, right: 96, bottom: 96, left: 96 },
}

const image = (over: Partial<Extract<Block, { kind: 'image' }>> = {}) => ({
  id: 'img',
  kind: 'image' as const,
  src: 'media://e3b0c442',
  width: 200,
  height: 100,
  alt: 'A floated figure',
  ...over,
})

const floatImg = (
  over: Partial<Extract<Block, { kind: 'image' }>> = {},
  float: { dx: number; dy: number; z: 'front' | 'behind' } = { dx: 0, dy: 0, z: 'front' },
) => image({ float, ...over })

const para = (
  id: string,
  text = 'hi',
  over: Omit<Partial<BlockBase>, 'id' | 'kind'> = {},
): Block => ({
  id,
  kind: 'paragraph',
  runs: [{ text, style }],
  ...over,
})

const filler = (id: string, tokens: number): Block => ({
  id,
  kind: 'paragraph',
  runs: [{ text: 'aaaa '.repeat(tokens), style: { fontFamily: 'sans-serif', fontSize: 100 } }],
})

const doc = (...blocks: Block[]): SemanticDoc => ({ baseStyle, blocks })

describe('anchored floats (E-IMG-3)', () => {
  it('a. layout is BYTE-IDENTICAL with/without the float — the text path never sees it', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const textBlocks = [para('a', 'First.'), para('b', 'Second.'), para('c', 'Third.')]

    const without = engine.layout(doc(...textBlocks), opts)
    const withFloat = engine.layout(
      doc(para('a', 'First.'), floatImg({ spaceBefore: 300 }, { dx: 120, dy: -40, z: 'behind' }), para('b', 'Second.'), para('c', 'Third.')),
      opts,
    )

    // The float contributes ZERO height — spacing included: text lays
    // out as if the block isn't there, byte-for-byte.
    expect(withFloat.lines).toEqual(without.lines)
    expect(withFloat.breaks).toEqual(without.breaks)
    expect(withFloat.pages).toEqual(without.pages)
    expect(withFloat.placed).toHaveLength(1)

    // spaceBefore is consumed into the ANCHOR (where the block would
    // have started: after para a's line at 17.6 + 300), never into the
    // flow cursor; dx/dy shift from the anchor x (alignOffset 0 for
    // left) and y.
    expect(withFloat.placed[0]).toMatchObject({
      blockId: 'img',
      pageIndex: 0,
      float: { dx: 120, dy: -40 },
      z: 'behind',
      rect: { x: 120, y: 17.6 + 300 - 40, width: 200, height: 100 },
    })
  })

  it('b. the float follows its anchor: an edit ABOVE moves the rect, including across a page boundary', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })

    // Short anchor paragraph → float on page 0, right below it.
    const r1 = engine.layout(doc(para('lead', 'One line.'), floatImg(), para('tail', 'x')), opts)
    expect(r1.placed[0].pageIndex).toBe(0)
    expect(r1.placed[0].rect.y).toBe(17.6)

    // Edit above grows the lead to 3 lines → the anchor (and the rect)
    // moves down within page 0.
    const r2 = engine.layout(doc(filler('lead', 36), floatImg(), para('tail', 'x')), opts)
    expect(r2.placed[0].pageIndex).toBe(0)
    expect(r2.placed[0].rect.y).toBe(3 * 110)

    // Edit above grows the lead to 8 lines → it fills page 0 (cap 7)
    // and fragments: the widow rule backs the split up to 6 + 2 (R3
    // adjust — n − fits == 1), so the anchor — the flow position
    // after the lead — crosses the boundary: pageIndex changes.
    const r3 = engine.layout(doc(filler('lead', 96), floatImg(), para('tail', 'x')), opts)
    expect(r3.placed[0].pageIndex).toBe(1)
    expect(r3.placed[0].rect.y).toBe(220)
  })

  it('c. clamping at all four page edges — the page box INCLUDING margins is the canvas', () => {
    // Four floats, all anchored at (0, 0) (each contributes zero
    // height, so every anchor is the same fresh page-top position).
    const result = createLayoutEngine({ metrics: FakeMetrics }).layout(
      doc(
        floatImg({ id: 'left' }, { dx: -300, dy: 0, z: 'front' }),
        floatImg({ id: 'right' }, { dx: 700, dy: 0, z: 'front' }),
        floatImg({ id: 'top' }, { dx: 0, dy: -300, z: 'front' }),
        floatImg({ id: 'bottom' }, { dx: 0, dy: 1000, z: 'front' }),
        para('tail', 'x'),
      ),
      opts,
    )

    expect(result.placed).toHaveLength(4)
    const byId = Object.fromEntries(result.placed.map((p) => [p.blockId, p]))
    // Emitted CONTENT-BOX-RELATIVE (single frame for placed[]): a
    // float in the margin carries NEGATIVE coordinates.
    expect(byId.left.rect.x).toBe(-96) // x_page −204 → clamped to 0
    expect(byId.right.rect.x).toBe(520) // x_page 796 → clamped to 816−200
    expect(byId.top.rect.y).toBe(-96) // y_page −204 → clamped to 0
    expect(byId.bottom.rect.y).toBe(860) // y_page 1096 → clamped to 1056−100
    // The float spec echoes into placed[] (cache-relevant: rides contentHash).
    expect(byId.left.float).toEqual({ dx: -300, dy: 0 })
  })

  it('d. z passthrough: front/behind echo to placed[] and change nothing else', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const front = engine.layout(doc(floatImg({}, { dx: 10, dy: 10, z: 'front' })), opts)
    const behind = engine.layout(doc(floatImg({}, { dx: 10, dy: 10, z: 'behind' })), opts)

    expect(front.placed[0].z).toBe('front')
    expect(behind.placed[0].z).toBe('behind')
    // z is PAINT ORDER, not layout: geometry is byte-identical.
    expect(front.lines).toEqual(behind.lines)
    expect(front.placed[0].rect).toEqual(behind.placed[0].rect)

    // A NON-floated block image carries neither field (absent
    // optionals — the additive shape existing consumers rely on).
    const plain = engine.layout(doc(image({ id: 'plain' })), opts)
    expect(plain.placed[0].z).toBeUndefined()
    expect(plain.placed[0].float).toBeUndefined()
  })

  it('e. bond loud-seam: any bond or forced break touching a floated image THROWS (ruled)', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const layout = (d: SemanticDoc) => engine.layout(d, opts)

    // On the float itself: keepNext, keepPrevious, breakBefore, breakAfter.
    expect(() => layout(doc(floatImg({ flow: { keepNext: true } })))).toThrow(/float/i)
    expect(() => layout(doc(floatImg({ flow: { keepPrevious: true } })))).toThrow(/float/i)
    expect(() => layout(doc(floatImg({ flow: { breakBefore: 'page' } })))).toThrow(/float/i)
    expect(() => layout(doc(floatImg({ flow: { breakAfter: 'page' } })))).toThrow(/float/i)
    // Bonds pointing INTO a float, either spelling, either side.
    expect(() => layout(doc(image({ id: 'a', flow: { keepNext: true } }), floatImg()))).toThrow(/float/i)
    expect(() => layout(doc(floatImg(), para('b', 'x', { flow: { keepPrevious: true } })))).toThrow(/float/i)

    // NOT loud: vacuous-by-construction flow on floats (keepLines/
    // widowControl, the block-image precedent) and null ≡ unset (PM
    // attribute JSON round-trips carry null for absent attrs — the
    // engine's === true checks treat it as unset; the cast stands in
    // for the JSON layer the type system can't express).
    expect(() => layout(doc(floatImg({ flow: { keepLines: true, widowControl: false } })))).not.toThrow()
    expect(() =>
      layout(doc(floatImg({ flow: { keepNext: null as unknown as boolean } }))),
    ).not.toThrow()
  })

  it('f. the ANCHOR-FRAGMENT edge: the float belongs to the fragment where the flow position lands', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })

    // Lead paragraph of 10 lines × 110px: 7 on page 0, 3 on page 1 —
    // the ANCHOR PARAGRAPH SPLITS across the boundary. The float's
    // anchor is the flow position AFTER it: (page 1, y 330) — the
    // fragment that ENDS the block.
    const lead = filler('lead', 120)
    const dyUp = floatImg({ id: 'up' }, { dx: 0, dy: -400, z: 'front' })
    const dyOver = floatImg({ id: 'over' }, { dx: 0, dy: -500, z: 'front' })

    const r = engine.layout(doc(lead, dyUp, dyOver, para('tail', 'x')), opts)
    expect(r.breaks).toEqual([{ blockId: 'lead', atLine: 7, pageIndex: 1 }])

    // RULED: pageIndex resolves from the ANCHOR, never from the
    // shifted rect — dy visually drags the rects toward page 0's
    // territory, but they stay on page 1, the fragment where the
    // flow position lands.
    const byId = Object.fromEntries(r.placed.map((p) => [p.blockId, p]))
    expect(byId.up.pageIndex).toBe(1)
    // y_page = 96 + 330 − 400 = 26 ≥ 0 → content-relative −70 (up into
    // page 1's margin, over page 1's first fragment lines).
    expect(byId.up.rect.y).toBe(-70)
    // Pushed past the page top → clamped to it, still page 1.
    expect(byId.over.pageIndex).toBe(1)
    expect(byId.over.rect.y).toBe(-96)

    // Control, dy 0: the rect sits exactly at the anchor.
    const r0 = engine.layout(doc(lead, floatImg({ id: 'at' }), para('tail', 'x')), opts)
    expect(r0.placed[0].pageIndex).toBe(1)
    expect(r0.placed[0].rect.y).toBe(330)
  })

  it('g. placed[] order: floats interleave with block images in DOCUMENT order', () => {
    const result = createLayoutEngine({ metrics: FakeMetrics }).layout(
      doc(
        image({ id: 'img1', width: 50, height: 50 }),
        para('p', 'text'),
        floatImg({ id: 'fl' }),
        image({ id: 'img2', width: 50, height: 50 }),
      ),
      opts,
    )

    expect(result.placed.map((p) => p.blockId)).toEqual(['img1', 'fl', 'img2'])
    // Zero flow presence: img2 sits right after the paragraph (50 +
    // 17.6), as if the float weren't there.
    expect(result.placed[2].rect.y).toBe(50 + 17.6)
  })

  it('h. a float materializes its page like any placed rect (trailing close + trailing float)', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })

    // A breakAfter on a TEXT block pushes the cursor to a fresh page;
    // the trailing float anchors there — page 1 exists because the
    // placed rect is on it (no line is).
    const r = engine.layout(
      doc(para('a', 'x'), para('b', 'y', { flow: { breakAfter: 'page' } }), floatImg()),
      opts,
    )
    expect(r.placed[0].pageIndex).toBe(1)
    expect(r.pages).toHaveLength(2)

    // A float-only doc: one page, the float on it.
    const r2 = engine.layout(doc(floatImg()), opts)
    expect(r2.pages).toHaveLength(1)
    expect(r2.placed[0].pageIndex).toBe(0)
  })

  it('i. cache: a float edit re-walks; an edit after it splices past, sharing the frozen rect zero-copy; warm ≡ cold', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const blocks: Block[] = [
      para('p1', 'One.'),
      floatImg({}, { dx: 10, dy: 0, z: 'front' }),
      para('p3', 'Three.'),
      para('p4', 'Four.'),
    ]
    const first = engine.layout(doc(...blocks), opts)
    expect(first.placed).toHaveLength(1)

    // Fully cache-served baseline.
    engine.layout(doc(...blocks), opts)
    expect(engine.lastStats.blocksWalked).toBe(0)

    // dx edit → hash miss (float rides contentHash: the rect echoes)
    // → re-walk; the tail splices.
    let edited = blocks.map((b) =>
      b.id === 'img' ? floatImg({}, { dx: 50, dy: 0, z: 'front' }) : b,
    )
    const warm = engine.layout(doc(...edited), opts)
    expect(engine.lastStats.blocksWalked).toBe(1)
    expect(warm.placed[0].float).toEqual({ dx: 50, dy: 0 })
    expect(warm.placed[0].rect.x).toBe(50)

    // Edit a MIDDLE block AFTER the float: the float's cached entry is
    // prefix-reused and the tail splices past it; the float's frozen
    // rect is the SAME object, zero-copy.
    edited = edited.map((b) => (b.id === 'p3' ? para('p3', 'Three, edited.') : b))
    const warm2 = engine.layout(doc(...edited), opts)
    expect(engine.lastStats.blocksSpliced).toBeGreaterThanOrEqual(1)
    expect(warm2.placed[0]).toBe(warm.placed[0])
    expect(Object.isFrozen(warm2.placed[0])).toBe(true)
    expect(Object.isFrozen(warm2.placed[0].float)).toBe(true)

    // Parity: warm deep-equals cold, placed[] included.
    const cold = createLayoutEngine({ metrics: FakeMetrics }).layout(doc(...edited), opts)
    expect(warm2.placed).toEqual(cold.placed)
    expect(warm2.lines).toEqual(cold.lines)
  })
})
