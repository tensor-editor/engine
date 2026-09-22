import { describe, expect, it } from 'vitest'
import { createLayoutEngine } from '../src/index.js'
import { FakeMetrics } from './fake-metrics.js'
import type { LayoutOptions, SemanticDoc } from '../src/index.js'

const opts: LayoutOptions = {
  page: { width: 816, height: 1056 },
  margins: { top: 96, right: 96, bottom: 96, left: 96 },
}

const round = (result: unknown) =>
  JSON.parse(
    JSON.stringify(result, (_k, v) =>
      typeof v === 'number' ? Math.round(v * 10) / 10 : v,
    ),
  )

describe('golden: single paragraph on a Letter page (FakeMetrics)', () => {
  it('produces one page and one measured line box', () => {
    const doc: SemanticDoc = {
      baseStyle: { fontFamily: 'sans-serif', fontSize: 16 },
      blocks: [
        {
          id: 'p1',
          kind: 'paragraph',
          runs: [
            {
              text: 'Hello, Tensor.',
              style: { fontFamily: 'sans-serif', fontSize: 16 },
            },
          ],
        },
      ],
    }

    const { layout } = createLayoutEngine({ metrics: FakeMetrics })
    const result = layout(doc, opts)
    expect(round(result)).toMatchSnapshot()
  })
})

describe('golden: 10-line fontSize-100 block across two pages (FakeMetrics)', () => {
  it('slices 7 + 3 with one FragmentBreak', () => {
    // "aaaa " × 120 tokens = 10 lines of 12 tokens (600px) each at
    // fontSize 100 → 110px line height → cap 7 on a Letter content box.
    const doc: SemanticDoc = {
      baseStyle: { fontFamily: 'sans-serif', fontSize: 16 },
      blocks: [
        {
          id: 'p1',
          kind: 'paragraph',
          runs: [
            {
              text: 'aaaa '.repeat(120),
              style: { fontFamily: 'sans-serif', fontSize: 100 },
            },
          ],
        },
      ],
    }

    const { layout } = createLayoutEngine({ metrics: FakeMetrics })
    const result = layout(doc, opts)
    expect(round(result)).toMatchSnapshot()
  })
})

describe('golden: bonded heading flagship (FakeMetrics)', () => {
  it('5/7/5: filler strands, keepNext heading moves fresh, paragraph splits', () => {
    // Flagship: filler (5 lines), heading (2 lines, keepNext bonded to
    // the paragraph), paragraph (10 lines) at fontSize 100 (110px
    // lines, cap 7). WITHOUT the bond the heading strands at page 0's
    // bottom; WITH it, the heading's start moves fresh to page 1, the
    // paragraph's first 5 lines follow it, and its last 5 open page 2.
    const doc: SemanticDoc = {
      baseStyle: { fontFamily: 'sans-serif', fontSize: 16 },
      blocks: [
        {
          id: 'filler',
          kind: 'paragraph',
          runs: [{ text: 'aaaa '.repeat(60), style: { fontFamily: 'sans-serif', fontSize: 100 } }],
        },
        {
          id: 'heading',
          kind: 'heading',
          level: 1,
          runs: [{ text: 'aaaa '.repeat(24), style: { fontFamily: 'sans-serif', fontSize: 100 } }],
          flow: { keepNext: true },
        },
        {
          id: 'para',
          kind: 'paragraph',
          runs: [{ text: 'aaaa '.repeat(120), style: { fontFamily: 'sans-serif', fontSize: 100 } }],
        },
      ],
    }

    const { layout } = createLayoutEngine({ metrics: FakeMetrics })
    const result = layout(doc, opts)
    expect(round(result)).toMatchSnapshot()
  })
})
