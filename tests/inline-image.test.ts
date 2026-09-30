import { describe, expect, it } from 'vitest'
import { createLayoutEngine } from '../src/index.js'
import { FakeMetrics } from './fake-metrics.js'
import type {
  Block,
  BlockBase,
  InlineImageRun,
  LayoutOptions,
  Run,
  SemanticDoc,
  TextRun,
  TextStyle,
} from '../src/index.js'

// E-IMG-2 — inline image objects: runs as a discriminated union, the
// UNBREAKABLE single-position token, bottom-at-baseline seating, the
// segment paint-data contract, and the cache surfaces.
//
// Letter page, 96px margins → contentBox 624 × 864 (FakeMetrics: 10px
// per char, fontSize-16 line = 17.6px tall, ascent 13.6, descent 4).

const style: TextStyle = { fontFamily: 'sans-serif', fontSize: 16 }
const baseStyle: TextStyle = { fontFamily: 'sans-serif', fontSize: 16 }
const opts: LayoutOptions = {
  page: { width: 816, height: 1056 },
  margins: { top: 96, right: 96, bottom: 96, left: 96 },
}

const t = (text: string): TextRun => ({ text, style })
const img = (over: Partial<InlineImageRun> = {}): InlineImageRun => ({
  kind: 'inlineImage',
  src: 'media://inline-e3b0c442',
  width: 300,
  height: 80,
  alt: 'An inline figure',
  ...over,
})
const para = (
  id: string,
  runs: Run[],
  over: Omit<Partial<BlockBase>, 'id' | 'kind'> = {},
): Block => ({
  id,
  kind: 'paragraph',
  runs,
  ...over,
})
const doc = (...blocks: Block[]): SemanticDoc => ({ baseStyle, blocks })

describe('inline images (E-IMG-2)', () => {
  it('1. mid-sentence object flows with surrounding text: one line, seating + segmentation pinned', () => {
    const result = createLayoutEngine({ metrics: FakeMetrics }).layout(
      doc(
        para('p', [t('aaaa aaaa aaaa '), img(), t(' bbbb')]),
        para('tail', [t('x')]),
      ),
      opts,
    )

    expect(result.lines).toHaveLength(2)
    const line = result.lines[0]
    // Whole run text (15 + 1 + 5 chars) fits: one line, width 150+300+50.
    expect(line.rangeStart).toBe(0)
    expect(line.rangeEnd).toBe(21)
    expect(line.rect.width).toBe(500)
    // SEATING (CSS default): the object's BOTTOM sits at the baseline —
    // it extends imageHeight ABOVE it, nothing below. ascent = max(13.6,
    // 80) = 80, descent = max(4, 0) = 4 → height 84, baseline 80.
    expect(line.baseline).toBe(80)
    expect(line.rect.height).toBe(80 + 4)
    // SEGMENTATION CONTRACT: the object occupies exactly ONE position
    // (15) in the concatenated text; the covering segment carries its
    // runIndex — the object marker the shell dispatches paint on.
    expect(line.segments).toEqual([
      { runIndex: 0, start: 0, end: 15 },
      { runIndex: 1, start: 15, end: 16 },
      { runIndex: 2, start: 16, end: 21 },
    ])
    // The tall line's height flows: the following block starts at 84.
    expect(result.lines[1].rect.y).toBe(84)
  })

  it('2. wrap-to-next-line: the object moves WHOLE; trim-space applies on both sides of it', () => {
    const result = createLayoutEngine({ metrics: FakeMetrics }).layout(
      doc(
        // 40 chars (400px) then a 620-wide object: 400 + 620 > 624 → the
        // break lands at the space before the object (trimmed); the
        // object alone (620 + one more char would overflow) takes the
        // next line, and the space AFTER it is trimmed as the break
        // space. Third line: the remaining text.
        para('p', [
          t('aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa '),
          img({ width: 620, height: 60 }),
          t(' bbbb bbbb bbbb'),
        ]),
      ),
      opts,
    )

    expect(result.lines).toHaveLength(3)
    const [l0, l1, l2] = result.lines
    expect([l0.rangeStart, l0.rangeEnd]).toEqual([0, 39]) // space at 39 trimmed
    expect(l0.rect.width).toBe(390)
    // The object WHOLE on its own line: [40, 41), unsplit.
    expect([l1.rangeStart, l1.rangeEnd]).toEqual([40, 41])
    expect(l1.rect.width).toBe(620)
    // Image-only line: ascent 60, descent 0 → height = baseline = 60.
    expect(l1.baseline).toBe(60)
    expect(l1.rect.height).toBe(60)
    expect(l1.segments).toEqual([{ runIndex: 1, start: 40, end: 41 }])
    // The space after the object (position 41) was the break space →
    // trimmed; line 2 starts at 42.
    expect([l2.rangeStart, l2.rangeEnd]).toEqual([42, 56])
    expect(l2.rect.width).toBe(140)
    // Lines stack: 17.6 + 60.
    expect(l1.rect.y).toBe(17.6)
    expect(l2.rect.y).toBe(77.6)
  })

  it('3. wrap-to-next-line with trailing text: the moved object shares its line with what follows', () => {
    const result = createLayoutEngine({ metrics: FakeMetrics }).layout(
      doc(
        para('p', [
          t('aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa '),
          img({ width: 300, height: 80 }),
          t(' bbbb'),
        ]),
      ),
      opts,
    )

    expect(result.lines).toHaveLength(2)
    const [l0, l1] = result.lines
    expect([l0.rangeStart, l0.rangeEnd]).toEqual([0, 39])
    // Object (300) + " bbbb" (50) fits the fresh line: 350.
    expect([l1.rangeStart, l1.rangeEnd]).toEqual([40, 46])
    expect(l1.rect.width).toBe(350)
    expect(l1.rect.height).toBe(84) // ascent 80 + text descent 4
    expect(l1.segments).toEqual([
      { runIndex: 1, start: 40, end: 41 },
      { runIndex: 2, start: 41, end: 46 },
    ])
  })

  it('4. tall object GROWS its line: height receipt = imageHeight + textDescent when the object dominates', () => {
    const result = createLayoutEngine({ metrics: FakeMetrics }).layout(
      doc(
        para('p', [t('x '), img({ width: 50, height: 500 }), t(' y')]),
        para('tail', [t('x')]),
      ),
      opts,
    )

    const line = result.lines[0]
    expect(line.rect.height).toBe(500 + 4) // THE RECEIPT
    expect(line.baseline).toBe(500)
    // The grown line flows: the following block starts at 504.
    expect(result.lines[1].rect.y).toBe(504)
  })

  it('5. clamp: an object wider than the content width takes its OWN line at the content width, aspect preserved', () => {
    const result = createLayoutEngine({ metrics: FakeMetrics }).layout(
      doc(
        para('p', [t('aaaa '), img({ width: 1248, height: 300 }), t(' after')]),
      ),
      opts,
    )

    expect(result.lines).toHaveLength(3)
    const [l0, l1, l2] = result.lines
    expect([l0.rangeStart, l0.rangeEnd]).toEqual([0, 4])
    // The clamped object: 1248×300 → 624×150 (the SAME fit-down
    // primitive as block images — one scale, no forked math).
    expect([l1.rangeStart, l1.rangeEnd]).toEqual([5, 6])
    expect(l1.rect.width).toBe(624) // == content width
    expect(l1.rect.height).toBe(150)
    expect(l1.baseline).toBe(150) // image-only line: ascent = height
    expect(l1.segments).toEqual([{ runIndex: 1, start: 5, end: 6 }])
    // The space at position 6 was the BREAK space (lastSpaceIn's
    // (from, to] window includes it) → trimmed; line 2 starts at 7.
    expect([l2.rangeStart, l2.rangeEnd]).toEqual([7, 12])
    expect(l2.rect.width).toBe(50)
  })

  it('6. line-0 forced floor: a block STARTING with a clamped object under a first-line indent overflows line 0 (line 0 cannot be empty)', () => {
    const result = createLayoutEngine({ metrics: FakeMetrics }).layout(
      doc(
        para(
          'p',
          [img({ width: 1248, height: 300 }), t(' tail')],
          { firstLineIndent: 300 },
        ),
      ),
      opts,
    )

    // The clamp uses the BASE wrap width (624), never the narrower
    // first-line width (324): dims must not depend on which line the
    // object lands on. Line 0 cannot be empty, so the over-wide object
    // is emitted anyway — the single-token floor, same family as the
    // overlong hard-split.
    expect(result.lines).toHaveLength(2)
    expect(result.lines[0].rect.width).toBe(624)
    expect(result.lines[0].rect.height).toBe(150)
    expect(result.lines[1].rangeStart).toBe(1)
    expect(result.lines[1].rect.width).toBe(50)
  })

  it('7. zero-dim guard shared with block images: any degenerate axis degrades the object to 1×1', () => {
    const result = createLayoutEngine({ metrics: FakeMetrics }).layout(
      doc(para('p', [t('ab '), img({ width: 0, height: 50 }), t(' cd')])),
      opts,
    )

    const line = result.lines[0]
    expect(line.rect.width).toBe(30 + 1 + 30)
    // The 1×1 object does not dominate the text line: 17.6 tall.
    expect(line.rect.height).toBeCloseTo(17.6)
    expect(line.segments[1]).toEqual({ runIndex: 1, start: 3, end: 4 })
  })

  it('8. two adjacent objects: one position each, both unsplit, both seated', () => {
    const result = createLayoutEngine({ metrics: FakeMetrics }).layout(
      doc(para('p', [t('ab '), img({ width: 50, height: 20 }), img({ width: 60, height: 30 }), t(' cd')])),
      opts,
    )

    const line = result.lines[0]
    expect(line.rect.width).toBe(30 + 50 + 60 + 30)
    // Tallest object (30) beats the text ascent (13.6): height 30 + 4.
    expect(line.rect.height).toBe(34)
    expect(line.baseline).toBe(30)
    expect(line.segments).toEqual([
      { runIndex: 0, start: 0, end: 3 },
      { runIndex: 1, start: 3, end: 4 },
      { runIndex: 2, start: 4, end: 5 },
      { runIndex: 3, start: 5, end: 8 },
    ])
  })

  it('9. linesRebroken receipt: an edit touching an inline-image block re-breaks it like any text (block images never do)', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const blocks: Block[] = [
      para('p1', [t('Hello '), img(), t(' world of text')]),
      para('p2', [t('Second.')]),
    ]
    engine.layout(doc(...blocks), opts)
    // Fully cache-served baseline.
    engine.layout(doc(...blocks), opts)
    expect(engine.lastStats.linesRebroken).toBe(0)

    // Dims edit → hash miss → the containing block RE-BREAKS (the
    // object lives inside breakLines — unlike a block image). WIDTH
    // ONLY: the height stays 80 so the block's exit state is
    // unchanged and the tail SPLICES (blocksWalked 1, not 2 — the
    // splice receipt rides along).
    let edited = blocks.map((b) =>
      b.id === 'p1'
        ? para('p1', [t('Hello '), img({ width: 310 }), t(' world of text')])
        : b,
    )
    engine.layout(doc(...edited), opts)
    expect(engine.lastStats.linesRebroken).toBe(1)
    expect(engine.lastStats.blocksWalked).toBe(1)

    // src edit: OPAQUE, no geometry — but hash-covered by construction
    // (the run mapping names kind/src/width/height/alt), so re-break.
    edited = edited.map((b) =>
      b.id === 'p1'
        ? para('p1', [t('Hello '), img({ src: 'media://other-sha' }), t(' world of text')])
        : b,
    )
    engine.layout(doc(...edited), opts)
    expect(engine.lastStats.linesRebroken).toBe(1)

    // alt edit: same rule.
    edited = edited.map((b) =>
      b.id === 'p1'
        ? para('p1', [t('Hello '), img({ alt: 'New alt' }), t(' world of text')])
        : b,
    )
    engine.layout(doc(...edited), opts)
    expect(engine.lastStats.linesRebroken).toBe(1)

    // Plain text edit: same receipt as before inline objects existed.
    edited = edited.map((b) =>
      b.id === 'p2' ? para('p2', [t('Second, edited.')]) : b,
    )
    engine.layout(doc(...edited), opts)
    expect(engine.lastStats.linesRebroken).toBe(1)
  })

  it('10. loud seam: inline objects are REFUSED in code blocks (ruled throw, never silent layout)', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const codey = {
      id: 'c',
      kind: 'codeBlock' as const,
      runs: [img() as Run],
    }
    expect(() => engine.layout(doc(codey), opts)).toThrow(/inline image/)
  })
})
