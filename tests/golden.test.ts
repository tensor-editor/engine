import { describe, expect, it } from 'vitest'
import { createLayoutEngine } from '../src/index.js'
import { FakeMetrics } from './fake-metrics.js'
import type { LayoutOptions, SemanticDoc } from '../src/index.js'

const doc: SemanticDoc = {
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

const opts: LayoutOptions = {
  page: { width: 816, height: 1056 },
  margins: { top: 96, right: 96, bottom: 96, left: 96 },
}

describe('golden: single paragraph on a Letter page (FakeMetrics)', () => {
  it('produces one page and one measured line box', () => {
    const { layout } = createLayoutEngine({ metrics: FakeMetrics })
    const result = layout(doc, opts)
    const rounded = JSON.parse(
      JSON.stringify(result, (_k, v) =>
        typeof v === 'number' ? Math.round(v * 10) / 10 : v,
      ),
    )
    expect(rounded).toMatchSnapshot()
  })
})
