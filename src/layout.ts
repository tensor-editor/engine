import type {
  LayoutOptions,
  LayoutResult,
  LineBox,
  PageGeometry,
  SemanticDoc,
} from './types.js'

// M0 STUB — full recompute on every call (v1 is allowed to be slow).
// TODO(M1+): use previous for incremental invalidation. `previous` is a
// PERF HINT only: consulting it may never change the correct answer — only
// how fast we get there.
export function layout(
  doc: SemanticDoc,
  opts: LayoutOptions,
  _previous?: LayoutResult,
): LayoutResult {
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
    if (block.kind !== 'paragraph') continue // M0: headings get no lines yet
    const text = block.runs.map((run) => run.text).join('')
    // TODO(M1): derive metrics from every run via the injected metrics port
    // (M0 simplification: first run's fontSize; empty paragraphs fall back
    // to 16pt).
    const fontSize = block.runs[0]?.style.fontSize ?? 16
    // TODO(M1): replace with measured metrics.
    const lineHeight = 1.5 * fontSize
    const baseline = 0.8 * lineHeight
    lines.push({
      blockId: block.id,
      lineIndex: 0,
      pageIndex: 0,
      rect: { x: 0, y, width: contentBox.width, height: lineHeight },
      baseline,
      rangeStart: 0,
      rangeEnd: text.length,
    })
    y += lineHeight
  }

  return { pages: [page], lines, breaks: [], version: 1 }
}
