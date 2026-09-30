import { describe, expect, it } from 'vitest'
import { alignOffset, createLayoutEngine } from '../src/index.js'
import { FakeMetrics } from './fake-metrics.js'
import type { Block, LayoutOptions, SemanticDoc, TextStyle } from '../src/index.js'

// E-IMG-1 — image blocks: atomic placement, fit-down, align via the
// shared alignOffset, the placed[] output, and the cache surfaces.
//
// Letter page, 96px margins → contentBox 624 × 864 (FakeMetrics: 10px
// per char, fontSize-16 line = 17.6px tall).

const style: TextStyle = { fontFamily: 'sans-serif', fontSize: 16 }
const baseStyle: TextStyle = { fontFamily: 'sans-serif', fontSize: 16 }
const opts: LayoutOptions = {
  page: { width: 816, height: 1056 },
  margins: { top: 96, right: 96, bottom: 96, left: 96 },
}

const image = (over: Partial<Extract<Block, { kind: 'image' }>> = {}) => ({
  id: 'img',
  kind: 'image' as const,
  src: 'media://e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  width: 200,
  height: 100,
  alt: 'A test image',
  ...over,
})

const para = (id: string, text = 'hi'): Block => ({
  id,
  kind: 'paragraph',
  runs: [{ text, style }],
})

const doc = (...blocks: Block[]): SemanticDoc => ({ baseStyle, blocks })

describe('image blocks (E-IMG-1)', () => {
  it('1. natural size: placed rect = intrinsic dims at the align position; the walk continues below it', () => {
    const result = createLayoutEngine({ metrics: FakeMetrics }).layout(
      doc(image(), para('p')),
      opts,
    )

    expect(result.placed).toHaveLength(1)
    expect(result.placed[0]).toMatchObject({
      blockId: 'img',
      kind: 'image',
      src: image().src,
      alt: 'A test image',
      pageIndex: 0,
    })
    // Natural size: 200×100 fits the 624×864 box → placed at intrinsic.
    expect(result.placed[0].rect).toEqual({ x: 0, y: 0, width: 200, height: 100 })
    // Occupies its height in the walk flow: the following block starts
    // below it.
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0].blockId).toBe('p')
    expect(result.lines[0].rect.y).toBe(100)
  })

  it('2. fit-down landscape: aspect preserved, placed width == contentWidth, next block y accounts for the scaled height', () => {
    // 1248×300 is wider than the 624 content box → scale 0.5 →
    // 624×150 (the bounding constraint is width; height follows).
    const result = createLayoutEngine({ metrics: FakeMetrics }).layout(
      doc(image({ width: 1248, height: 300 }), para('p')),
      opts,
    )

    expect(result.placed[0].rect).toEqual({ x: 0, y: 0, width: 624, height: 150 })
    expect(result.lines[0].rect.y).toBe(150)
  })

  it('3. fit-down portrait, taller than a page: clamped to the content box on both axes; a page-too-small image never loops (R6 floor family)', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })

    // 400×1728 = exactly 2× the 864 content height → scale 0.5 →
    // 200×864: both axes within the box.
    const r1 = engine.layout(doc(image({ width: 400, height: 1728 }), para('p')), opts)
    expect(r1.placed[0].rect).toEqual({ x: 0, y: 0, width: 200, height: 864 })
    expect(r1.pages).toHaveLength(2)
    expect(r1.lines[0].pageIndex).toBe(1) // 864 used; the paragraph opens page 1

    // 3× the page height — placed (scaled), never a loop.
    const r2 = engine.layout(doc(image({ width: 400, height: 2592 }), para('p')), opts)
    expect(r2.placed[0].rect).toEqual({
      x: 0,
      y: 0,
      width: 400 * (864 / 2592),
      height: 864,
    })
    expect(r2.pages).toHaveLength(2)

    // ZERO-DIM GUARD: any non-positive axis degrades the WHOLE
    // intrinsic to 1×1 (a 200×0 image is as degenerate as a 0×0 one —
    // half an image is not an image), then normal fit-down.
    const r2b = engine.layout(doc(image({ width: 200, height: 0 }), para('p')), opts)
    expect(r2b.placed[0].rect).toEqual({ x: 0, y: 0, width: 1, height: 1 })
    expect(r2b.lines[0].rect.y).toBe(1)
    const r2c = engine.layout(doc(image({ width: 0, height: 0 }), para('p')), opts)
    expect(r2c.placed[0].rect).toEqual({ x: 0, y: 0, width: 1, height: 1 })

    // R6 floor family: spaceBefore on a fresh page pushes the scaled
    // image past the bottom → placed anyway, overflowing, walk
    // continues (mirrors the single-line-taller-than-page degenerate).
    const r3 = engine.layout(
      doc(image({ width: 400, height: 1728, spaceBefore: 300 }), para('p')),
      opts,
    )
    expect(r3.placed[0].rect).toEqual({ x: 0, y: 300, width: 200, height: 864 })
    expect(r3.pages).toHaveLength(2)
    expect(r3.lines[0].pageIndex).toBe(1)
  })

  it('4. align x positions come from the shared alignOffset — no second derivation', () => {
    for (const align of ['left', 'center', 'right'] as const) {
      const result = createLayoutEngine({ metrics: FakeMetrics }).layout(
        doc(image({ align })),
        opts,
      )
      // The SAME function paint/caret consume (M5.13) produced this x.
      expect(result.placed[0].rect.x).toBe(alignOffset(align, 200, 624))
    }
    // And the numbers themselves, pinned:
    expect(alignOffset('left', 200, 624)).toBe(0)
    expect(alignOffset('center', 200, 624)).toBe(212)
    expect(alignOffset('right', 200, 624)).toBe(424)
  })

  it('5. keepNext bond: an image bonds to a following caption-style block — never split across pages (ToF #31 dependency)', () => {
    // Filler: 7 lines × 110px = 770 (cap 7 on 864). The image (90×90)
    // fits at y 770..860, but the caption's first line (17.6) does not
    // → the bond moves the image fresh to page 1 and the caption
    // follows it.
    const filler: Block = {
      id: 'filler',
      kind: 'paragraph',
      runs: [{ text: 'aaaa '.repeat(84), style: { fontFamily: 'sans-serif', fontSize: 100 } }],
    }
    const caption = para('caption', 'Figure 1. A caption.')

    const bonded = createLayoutEngine({ metrics: FakeMetrics }).layout(
      doc(filler, image({ width: 90, height: 90, flow: { keepNext: true } }), caption),
      opts,
    )
    expect(bonded.placed[0].pageIndex).toBe(1)
    expect(bonded.placed[0].rect).toEqual({ x: 0, y: 0, width: 90, height: 90 })
    const captionLines = bonded.lines.filter((l) => l.blockId === 'caption')
    expect(captionLines).toHaveLength(1)
    expect(captionLines[0].pageIndex).toBe(1)
    expect(captionLines[0].rect.y).toBe(90)

    // Control, no bond: the image strands at page 0's bottom, the
    // caption opens page 1 alone.
    const stranded = createLayoutEngine({ metrics: FakeMetrics }).layout(
      doc(filler, image({ width: 90, height: 90 }), caption),
      opts,
    )
    expect(stranded.placed[0].pageIndex).toBe(0)
    expect(stranded.placed[0].rect.y).toBe(770)
    expect(stranded.lines.filter((l) => l.blockId === 'caption')[0].pageIndex).toBe(1)
  })

  it('6. contentHash: width/align/src/alt edits re-walk (blocksWalked receipt); an image placement never re-breaks lines (linesRebroken stays 0)', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const blocks = [
      para('p1', 'First paragraph.'),
      image(),
      para('p3', 'Third paragraph.'),
      para('p4', 'Fourth paragraph.'),
    ]
    engine.layout(doc(...blocks), opts)

    // Fully cache-served baseline.
    engine.layout(doc(...blocks), opts)
    expect(engine.lastStats.blocksWalked).toBe(0)

    // width change → hash miss at the image → re-walk; the exit state
    // is unchanged (height still 100) so the tail splices. STATS PIN:
    // an image re-placement shows walk/splice movement while
    // linesRebroken stays 0 — images never break lines.
    let edited = blocks.map((b) =>
      b.id === 'img' ? { ...b, width: 300 } as Block : b,
    )
    engine.layout(doc(...edited), opts)
    expect(engine.lastStats.blocksWalked).toBe(1)
    expect(engine.lastStats.blocksSpliced).toBe(2)
    expect(engine.lastStats.linesRebroken).toBe(0)

    // align change → re-walk (placement-relevant).
    edited = edited.map((b) => (b.id === 'img' ? { ...b, align: 'center' } as Block : b))
    engine.layout(doc(...edited), opts)
    expect(engine.lastStats.blocksWalked).toBe(1)
    expect(engine.lastStats.linesRebroken).toBe(0)

    // src change → nothing geometric remeasures, but the hash rule
    // re-walks; the echo updates.
    edited = edited.map((b) =>
      b.id === 'img' ? { ...b, src: 'media://deadbeef' } as Block : b,
    )
    engine.layout(doc(...edited), opts)
    expect(engine.lastStats.blocksWalked).toBe(1)
    expect(engine.lastStats.linesRebroken).toBe(0)
    expect(engine.layout(doc(...edited), opts).placed[0].src).toBe('media://deadbeef')

    // alt change → cache-relevant (placed[] echoes alt), never
    // geometry: re-walk, and the warm echo is FRESH, not stale.
    edited = edited.map((b) => (b.id === 'img' ? { ...b, alt: 'New alt' } as Block : b))
    engine.layout(doc(...edited), opts)
    expect(engine.lastStats.blocksWalked).toBe(1)
    expect(engine.lastStats.linesRebroken).toBe(0)
    expect(engine.layout(doc(...edited), opts).placed[0].alt).toBe('New alt')
  })

  it('7. incremental: an edit AFTER an image splices past it — the walkCache entry covers atomic blocks like any other; parity warm/cold', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const blocks = [
      para('p1', 'One.'),
      para('p2', 'Two.'),
      image({ width: 600, height: 400 }),
      para('p4', 'Four.'),
      para('p5', 'Five.'),
      para('p6', 'Six.'),
    ]
    const first = engine.layout(doc(...blocks), opts)
    expect(first.placed).toHaveLength(1)

    // Edit AFTER the image: the walk resumes at the edit; the image's
    // walkCache entry is spliced (atomic blocks cache like any other)
    // and its PlacedRect is the SAME frozen object (zero-copy sharing).
    const edited = blocks.map((b) =>
      b.id === 'p5' ? { ...b, runs: [{ text: 'Five, edited.', style }] } : b,
    )
    const warm = engine.layout(doc(...edited), opts)
    expect(engine.lastStats.blocksSpliced).toBeGreaterThanOrEqual(1)
    expect(warm.placed[0]).toBe(first.placed[0]) // identical frozen object
    expect(warm.placed[0].rect).toEqual({ x: 0, y: 35.2, width: 600, height: 400 })

    // Parity: warm deep-equals cold, placed[] included.
    const cold = createLayoutEngine({ metrics: FakeMetrics }).layout(doc(...edited), opts)
    expect(warm.pages).toEqual(cold.pages)
    expect(warm.lines).toEqual(cold.lines)
    expect(warm.breaks).toEqual(cold.breaks)
    expect(warm.placed).toEqual(cold.placed)
  })
})
