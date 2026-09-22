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

/**
 * Per-block flow control. Field names deliberately mirror OOXML
 * (w:keepNext, w:keepLines, ...) for a future DOCX round-trip.
 */
export interface FlowPolicy {
  /**
   * Atomic placement: never split this block across pages. Blocks taller
   * than a page still fragment — you can't keep together what can't fit
   * together.
   */
  keepLines?: boolean
  /**
   * Widow/orphan protection for this block. Overrides the DOCUMENT-LEVEL
   * DEFAULT (LayoutOptions.preventWidowsAndOrphans). false = natural
   * split (no boundary adjustments).
   */
  widowControl?: boolean
  /** M2.5 — not yet implemented; a genuinely set value throws. */
  keepNext?: boolean
  /** M2.5 — not yet implemented; a genuinely set value throws. */
  keepPrevious?: boolean
  /** M2.5 — not yet implemented; a genuinely set value throws. */
  breakBefore?: 'page' | null
  /** M2.5 — not yet implemented; a genuinely set value throws. */
  breakAfter?: 'page' | null
}

export interface BlockBase {
  id: string
  kind: 'paragraph' | 'heading'
  flow?: FlowPolicy
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
  /**
   * REQUIRED document default font, supplied by the adapter — defaults
   * live at the edges, never in the engine. Feeds empty-line metrics (a
   * line with no runs has no style of its own to measure).
   */
  baseStyle: TextStyle
}

export interface LayoutOptions {
  page: { width: number; height: number }
  margins: { top: number; right: number; bottom: number; left: number }
  /**
   * DOCUMENT-LEVEL DEFAULT for widow/orphan protection. Default true
   * when omitted; per-block flow.widowControl overrides this.
   */
  preventWidowsAndOrphans?: boolean
}

export interface PageGeometry {
  index: number
  size: Rect
  contentBox: Rect
  // M2: all pages share opts geometry. TODO(sections): per-section
  // page descriptors.
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
  /**
   * Edit survival: a positional line ordinal, recomputed on every layout.
   * Pin: emitted ONLY when a block splits mid-block. atLine = the
   * lineIndex of the block's first line on pageIndex (the line that
   * begins the new page); atLine >= 1 always. A block pushed wholly to
   * a new page emits NO FragmentBreak.
   */
  atLine: number
  /** Index of the page the continuation begins on. */
  pageIndex: number
}

export interface LayoutResult {
  pages: PageGeometry[]
  /** Document order. */
  lines: LineBox[]
  breaks: FragmentBreak[]
  version: number
}
