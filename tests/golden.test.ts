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
