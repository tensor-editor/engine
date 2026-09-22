import type {
  LayoutOptions,
  LayoutResult,
  LineBox,
  PageGeometry,
  SemanticDoc,
  TextMetrics,
} from './types.js'
import { breakLines } from './line-breaker.js'

// M1: full recompute on every call (v1 is allowed to be slow).
// TODO(M2+): use previous for incremental invalidation. `previous` is a
// PERF HINT only: consulting it may never change the correct answer — only
// how fast we get there.

export function createLayoutEngine({ metrics }: { metrics: TextMetrics }): {
  layout(doc: SemanticDoc, opts: LayoutOptions, previous?: LayoutResult): LayoutResult
} {
  return {
    layout(doc, opts, _previous?: LayoutResult): LayoutResult {
      const size = {
        x: 0,
        y: 0,
        width: opts.page.width,
        height: opts.page.height,
      }
      const contentBox = {
        x: opts.margins.left,
        y: opts.margins.top,
        width: opts.page.width - opts.margins.left - opts.margins.right,
        height: opts.page.height - opts.margins.top - opts.margins.bottom,
      }
      const page: PageGeometry = { index: 0, size, contentBox }

      const lines: LineBox[] = []
      let y = 0
      for (const block of doc.blocks) {
        if (block.kind !== 'paragraph') continue // TODO(M2+): headings
        const results = breakLines(block.runs, metrics, contentBox.width)
        for (const [lineIndex, result] of results.entries()) {
          lines.push({
            blockId: block.id,
            lineIndex,
            // TODO(M2): slice into pages — content may overflow the page
            // bottom for now.
            pageIndex: 0,
            rect: { x: 0, y, width: result.width, height: result.height },
            baseline: result.baseline,
            rangeStart: result.start,
            rangeEnd: result.end,
            segments: result.segments,
          })
          y += result.height
        }
      }

      return { pages: [page], lines, breaks: [], version: 1 }
    },
  }
}
