// tensor-engine data model. Pure data declarations only — behavior
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
  /**
   * Line-height multiplier, default 1.0. BOTTOM-ONLY LEADING (M6
   * ruling — spec of record): a line box's height = (ascent +
   * descent) × lineHeight and the baseline sits at `ascent` from the
   * box top; ALL the added leading lives BELOW the glyphs.
   * Rationale: the top-left of a line box is always text — inter-line
   * space lives below, and above-line space belongs to the block
   * tier (spaceBefore/spaceAfter), never to the line. Word-family
   * convention, deliberately chosen over CSS half-leading.
   * INVARIANT: absent or 1.0 produces numbers IDENTICAL to the
   * lineHeight-free layout — pinned bit-for-bit by tests.
   */
  lineHeight?: number
  /**
   * Variant caps (M-STYLES): 'small-caps' is LAYOUT-RELEVANT, not
   * paint-only — small-cap glyphs measure narrower than full caps in
   * real fonts, so the metrics PORT consumes it (measure/ascent/
   * descent all key on the full style). The engine never interprets
   * it: it flows through run.style into contentHash (a variant edit
   * re-breaks the run's block) and is handed back opaquely to the
   * measurer. Test doubles may ignore it (FakeMetrics does — its
   * width depends only on text length), but the REAL metrics must
   * apply it or measured widths diverge from painted advances.
   */
  fontVariant?: 'small-caps' | 'normal'
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
 * (w:keepNext, w:keepLines, ...) for a future DOCX round-trip. null
 * counts as UNSET at every use site — PM attribute JSON round-trips
 * use null for absent attrs.
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
  /**
   * BOND (A→B): A's last line and B's first line share a page.
   * Enforced at A's placement via a lookahead of B's first-line height;
   * bounded shapes, give-up drops loudly.
   */
  keepNext?: boolean
  /** BOND: same bond as keepNext on the previous block — one mechanism, two spellings. */
  keepPrevious?: boolean
  /**
   * Structural tier (precedence 1): force a page break before this
   * block. A fresh-page start is a no-op. A bond at this boundary
   * drops — a page that must start with B cannot also start with A's
   * last fragment.
   */
  breakBefore?: 'page' | null
  /** Structural tier (precedence 1): force a page break after this block. Emits no FragmentBreak. */
  breakAfter?: 'page' | null
}

export interface BlockBase {
  id: string
  kind: 'paragraph' | 'heading' | 'codeBlock' | 'image'
  flow?: FlowPolicy
  /**
   * Vertical space (px) above the block's first line. Applied ONCE at
   * block entry: fragment continuations (a mid-block page split) never
   * re-apply it. Consumed before the fit walk, so fits/orphan/widow
   * evaluate against the line tops; the y>0 loop-freedom guards test
   * the PRE-spaceBefore cursor (spaceBefore is not "content" — a page
   * holding only spaceBefore is still fresh).
   */
  spaceBefore?: number
  /** Vertical space (px) after the block's last line. Participates in the NEXT block's fits. */
  spaceAfter?: number
  /**
   * BLOCK-LEVEL INDENT GEOMETRY (px, default 0): narrows the wrap
   * width (contentBox.width − indentLeft) and shifts every LineBox
   * rect.x to indentLeft. It is NOT a run style — it never paints, it
   * only changes wrapping and placement. Horizontal, so unlike
   * spaceBefore it applies to EVERY line of EVERY fragment: a mid-block
   * page split keeps the indent on the continuation.
   */
  indentLeft?: number
  /**
   * Right half of the indent family (px, default 0): narrows the
   * wrap width from the RIGHT (contentBox.width − indentLeft −
   * indentRight). rect.x stays at indentLeft; the measured widths
   * come from the narrower wrap. Preserved on fragment continuations
   * like indentLeft.
   */
  indentRight?: number
  /**
   * FIRST-LINE INDENT (px, default 0; the indent family's third
   * member): ONLY lineIndex 0 of the block gets effective left
   * indent = indentLeft + firstLineIndent, and line 0 BREAKS at its
   * own width (first line wraps at contentBox.width − (indentLeft +
   * firstLineIndent) − indentRight; wrapped lines at the base
   * width). POSITIVE indents the first line INWARD; NEGATIVE under a
   * larger indentLeft is the HANGING indent (the classic
   * bibliography/legal style: line 0 sits out at the left, wrapped
   * lines sit in at indentLeft) — there is deliberately NO third
   * field for it. CONTINUATION RULE (mirror of spaceBefore's): the
   * first-line indent applies ONCE, at the block's true start
   * (lineIndex 0, wherever the start rules put it); fragments on
   * later pages resume at the BASE indent. LOUD SEAM: the engine
   * THROWS on a negative computed left edge (indentLeft +
   * firstLineIndent < 0) — the adapter must validate before sending.
   */
  firstLineIndent?: number
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

/**
 * ADAPTER CONTRACT — PAGELESS LOOK, matched not redesigned: in the
 * pageless editor a code block renders through TipTap's CodeBlock
 * extension as `<pre><code>` with NO font of its own; the UA
 * stylesheet's `pre { font-family: monospace }` applies and the
 * font-size INHERITS the editor container's document-default size
 * (16px in the shell config). So the shell's adapter must emit runs
 * carrying `fontFamily: 'monospace'` + the document-default size —
 * the engine never restyles, it breaks runs as given.
 */
export interface CodeBlockBlock extends BlockBase {
  kind: 'codeBlock'
  runs: Run[]
}

export type Block = ParagraphBlock | HeadingBlock | CodeBlockBlock | ImageBlock

/**
 * ATOMIC VISUAL BLOCK — image. Never fragmented, never line-broken:
 * exactly ONE placement decision in the walk (a single synthetic "line"
 * internally). src is OPAQUE: the engine never resolves or loads it —
 * in Tensor it is 'media://<sha256>', but the engine treats it as an
 * uninterpreted string that only echoes through to placed[]. The
 * intrinsic width/height are REQUIRED DOCUMENT DATA (the adapter
 * supplies them; the engine never fetches anything at layout time).
 * Two-sided law: the SHELL must never compute layout — a shell-side
 * scale would be a second derivation; the engine owns this math and
 * emits the FINAL placed dims in placed[]. The indent family is wrap
 * geometry and is IGNORED for images (they don't wrap); `align` is
 * their horizontal control, relative to the full content box
 * (Word: a centered image centers on the column, not the indented
 * text edge). keepLines on an image is vacuous by construction —
 * atomicity is structural, not a keepLines special case.
 */
export interface ImageBlock extends BlockBase {
  kind: 'image'
  /** OPAQUE — never resolved or loaded; echoes through to placed[]. */
  src: string
  /** Intrinsic px, REQUIRED document data, never fetched at layout time. */
  width: number
  height: number
  /** Default 'left'. Positions the placed rect via the shared alignOffset. */
  align?: 'left' | 'center' | 'right'
  /** OPAQUE echo — a11y metadata, never rendered by the engine. */
  alt: string
}

export interface SemanticDoc {
  blocks: Block[]
  /**
   * REQUIRED document default font, supplied by the adapter — defaults
   * live at the edges, never in the engine. Feeds empty-line metrics:
   * a PRESENT run's style (even zero-length — the adapter's
   * empty-textblock projection) wins over baseStyle; baseStyle is the
   * no-runs-at-all fallback only (P1 ruling).
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
  // All pages share opts geometry. TODO(sections): per-section
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

/**
 * Per-call cache statistics — DEBUG SURFACE, documented as such: not
 * API-stable, never consulted by the engine itself.
 */
export interface LastStats {
  /** Blocks placed through the walk machine this call (lineCache hits count). */
  blocksWalked: number
  /** breakLines() invocations this call (lineCache misses). */
  linesRebroken: number
  /** Cached walk entries consumed by verified splice this call. */
  blocksSpliced: number
  /**
   * Current cache epoch. Persists across calls; resets to 0 in a fresh
   * engine; increments on wholesale (opts/baseStyle) invalidation.
   */
  cacheEpoch: number
  /** True when an opts/baseStyle change dropped the caches this call. */
  invalidated: boolean
}

/**
 * One ATOMIC VISUAL block's placement — images now; horizontalRule may
 * migrate to this array later (do not assume kind is only 'image').
 * Field set designed so FLOATS (a future session) extend it additively
 * with z. Order discipline: placed[] follows DOCUMENT order, exactly
 * like lines[] — a sibling array, never interleaved with it; consumers
 * merge the two by (pageIndex, rect.y). Images never appear in lines[].
 * Edit survival: echoes (src, alt) are the adapter's stable strings;
 * the rect is recomputed every layout (positional, like LineBox.rect).
 */
export interface PlacedRect {
  /** Edit survival: author-assigned, stable across edits by contract. */
  blockId: string
  kind: 'image'
  /** OPAQUE echo of ImageBlock.src. */
  src: string
  /** OPAQUE echo of ImageBlock.alt — cache-relevant: it rides contentHash. */
  alt: string
  pageIndex: number
  /** Relative to the page content box — same frame as LineBox.rect. */
  rect: Rect
}

/**
 * Treat as immutable. The engine shares cached LineBox/FragmentBreak/
 * PlacedRect objects across results (zero-copy); callers mutating them
 * corrupt the cache AND parity. Emitted records are Object.freeze'd.
 */
export interface LayoutResult {
  pages: PageGeometry[]
  /** Document order. */
  lines: LineBox[]
  breaks: FragmentBreak[]
  /**
   * Document order. One entry per atomic visual block (images now);
   * floats will extend this array additively. Sibling of lines[] —
   * consumers merge by (pageIndex, rect.y).
   */
  placed: PlacedRect[]
  /**
   * Cheap staleness signal, NOT a guarantee of change. Bumps ONLY when
   * a call performed any re-break/re-walk; a fully-cache-served call
   * keeps version.
   */
  version: number
}

export interface LayoutEngine {
  layout(doc: SemanticDoc, opts: LayoutOptions): LayoutResult
  /**
   * Debug surface: stats of the LAST layout() call. Rebuilt from
   * scratch every call — never accumulated (a stale counter would
   * make the scripted counts lie). Not API-stable.
   */
  readonly lastStats: LastStats
}
