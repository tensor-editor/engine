// tensor-engine data model (M0). Pure data declarations only — behavior
// lives in layout.ts.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface TextStyle {
  fontFamily: string
  fontSize: number
  bold?: boolean
  italic?: boolean
}

export interface Run {
  text: string
  style: TextStyle
}

/**
 * Port only. The real (canvas-based) implementation lives in the shell
 * repo, never here. The engine consumes measurement; it does not perform
 * it. No caching in the engine — memoization is the production metrics
 * implementation's job.
 */
export interface TextMetrics {
  /** Advance width of `text` under `style`, in px. */
  measure(text: string, style: TextStyle): number
  ascent(style: TextStyle): number
  descent(style: TextStyle): number
}

export interface LineSegment {
  /** Index into the paragraph's runs array. */
  runIndex: number
  /**
   * Offsets into the concatenated run text, clamped to the line's range.
   * Edit survival: plain character offsets, same contract as LineResult
   * start/end — edits before an offset shift it.
   */
  start: number
  end: number
}

export interface LineResult {
  /**
   * Offsets into the concatenated run text (runs joined in array order).
   * Edit survival: plain character offsets — edits before an offset shift
   * it; they name source positions, not re-flowed fragments.
   */
  start: number
  end: number
  /** Run boundaries survive breaking. */
  segments: LineSegment[]
  /** Measured. */
  width: number
  /** Max ascent + max descent over runs in the line. */
  height: number
  /** Max ascent over runs in the line. */
  baseline: number
}

export interface BlockBase {
  id: string
  kind: 'paragraph' | 'heading'
}

export interface ParagraphBlock extends BlockBase {
  kind: 'paragraph'
  runs: Run[]
}

export interface HeadingBlock extends BlockBase {
  kind: 'heading'
  level: number
  runs: Run[]
}

export type Block = ParagraphBlock | HeadingBlock

export interface SemanticDoc {
  blocks: Block[]
}

export interface LayoutOptions {
  page: { width: number; height: number }
  margins: { top: number; right: number; bottom: number; left: number }
}

export interface PageGeometry {
  index: number
  size: Rect
  contentBox: Rect
}

export interface LineBox {
  /** Edit survival: author-assigned, stable across edits by contract. */
  blockId: string
  /**
   * 0-based within the block, continuous across page fragments.
   * Edit survival: a positional ordinal recomputed on every layout — an
   * inserted line before it shifts the number, so treat it as position,
   * not stable identity.
   */
  lineIndex: number
  pageIndex: number
  /** Relative to the page content box. */
  rect: Rect
  baseline: number
  /**
   * Offsets into the block's concatenated run text (runs joined in array
   * order). Edit survival: plain character offsets — edits before an offset
   * shift it; they name source positions, which do survive edits, not
   * re-flowed fragments.
   */
  rangeStart: number
  rangeEnd: number
  /**
   * Copied from the line's LineResult — consumers never derive run
   * boundaries. Edit survival: plain character offsets into the
   * concatenated run text, same contract as rangeStart/rangeEnd.
   */
  segments: LineSegment[]
}

export interface FragmentBreak {
  blockId: string
  /** Edit survival: a positional line ordinal, recomputed on every layout. */
  atLine: number
  pageIndex: number
}

export interface LayoutResult {
  pages: PageGeometry[]
  /** Document order. */
  lines: LineBox[]
  breaks: FragmentBreak[]
  version: number
}
