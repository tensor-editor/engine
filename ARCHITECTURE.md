# Architecture

This document serves as an architectural reference for the `@tensor-editor/engine` repository's internal codebase, design system, and code logic. It primarily serves as the main layout and pagination engine for the `@tensor-editor/tensor` project.

---

## 1. Repository Description

`@tensor-editor/engine` is a **headless document layout engine**: it takes a semantic description of a document (paragraphs, headings, text runs with styles) and produces **positioned geometry**: *which line of text sits on which page, at which coordinates, with its baseline where?*

```
SemanticDoc  ──▶  createLayoutEngine({ metrics })  ──▶  LayoutResult
(blocks + styles)      (pure layout machine)          (pages + line boxes)
```

It is the layout core of the Tensor editor. It **never renders anything**: no canvas, no DOM, no fonts. This is enforced by `tests/purity.test.ts`, which scans `src/` for banned API references:

```ts
// tests/purity.test.ts
if (
  code.includes('document.') ||
  code.includes('window.') ||
  code.includes('OffscreenCanvas') ||
  code.includes('HTMLCanvasElement') ||
  code.includes('createElement')
) {
  violations.push(`${file}: references DOM/canvas APIs`)
}
```

Why purity? Two reasons:

1. First, a layout engine that can't touch a ruler must be *given* one: all font measurement flows through an injected **[metrics port](#5-measurement-the-textmetrics-port)**, which makes the engine testable with a fake ruler and runnable in any JS environment. 
2. The engine's output is a deterministic function of its inputs, which is the foundation of the [incremental cache](#7-the-incremental-cache) and its central guarantee, the **[parity law](#71-the-parity-law)**.

The repository is TypeScript, ESM, with **zero runtime dependencies** and three dev dependencies (`typescript`, `vitest`, `@types/node`).

---

## 2. Repository Map

```
src/
  index.ts               public entry: re-exports types + createLayoutEngine
  types.ts               the data model — all public types, pure declarations
  layout.ts              the walk driver: slicing, flow policy, incremental cache
  line-breaker.ts        text → LineResults (the greedy line breaker)
tests/
  fake-metrics.ts        pure test ruler: 10px per character (no canvas)
  line-breaker.test.ts   breaker unit tests + lineHeight model tests
  layout.test.ts         measured line boxes + empty-paragraph fallback
  slicer.test.ts         page-slicing rules, 12 pinned cases
  flow.test.ts           bonds + forced breaks, 14 pinned cases
  incremental.test.ts    cache statistics, scripted 300-block scenario
  golden.test.ts         3 committed snapshot fixtures
  parity.fuzz.test.ts    40×15 randomized ops, warm vs cold engine
  hash-identity.test.ts  the block-identity hash cache, both directions
  purity.test.ts         src/ bans DOM/canvas/react
  gen-perf71.ts          generator for perf-71.json (run via tsx in the
  perf-71.json           shell checkout) — the canonical 71-page stress
                         doc; deterministic, byte-identical regeneration
tsconfig.build.json      build config: emits compiled JS + declarations
dist/                    build output (gitignored; produced by npm run build)
ARCHITECTURE.md          this document
```

Commands:

```
npm install @tensor-editor/engine
npm run typecheck    # tsc --noEmit
npm run build        # tsc -p tsconfig.build.json → dist/ (JS + .d.ts)
npm test             # vitest run (94 tests, ~1s)
```

The package, as part of the Tensor project, is licensed under the **AGPL-3.0**.

> [!NOTE]
> The package is publish-ready. The `exports` map points at the compiled `dist/` output (`types` + `import`), the `files` field ships `dist/` plus this document and the `LICENSE`, and `npm run build` produces the artifact that `npm publish` would upload. Publishing itself is a deliberate release step performed by a maintainer, not something the build does.

---

## 3. Public API

Everything the outside world touches is in `src/types.ts` and this factory in `src/layout.ts`:

```ts
// src/layout.ts
export function createLayoutEngine({ metrics }: { metrics: TextMetrics }): LayoutEngine
```

```ts
// src/types.ts
export interface LayoutEngine {
  layout(doc: SemanticDoc, opts: LayoutOptions): LayoutResult
  /**
   * Debug surface: stats of the LAST layout() call. Rebuilt from scratch
   * every call — never accumulated. Not API-stable.
   */
  readonly lastStats: LastStats
}
```

Three rules about the instance:

1. **Hold ONE stable engine instance.** The [incremental cache](#7-the-incremental-cache) lives inside the instance. Throwing the engine away after every call forfeits all caching, and two engines won't share caches.
2. **A new metrics implementation requires a new engine.** The metrics port is bound at construction.
3. **Reuse unchanged `Block` objects BY REFERENCE across calls.** The [hash identity cache](#72-what-is-cached) depends on it. Treat blocks as immutable: an edited block must be a NEW object. ProseMirror's structural sharing makes this natural for the shell's adapter,[^pm] which is exactly what the adapter-contract comment in `layout.ts` requires.

The shell's word processor renders its paginated mode from this engine: `PageGeometry[]` becomes sheets, `LineBox[]` segments become styled glyphs, and the caret is synthesized from the same metrics instance. The incremental cache is load-bearing in production: a warm keystroke layout walks only the edited block (see the README's `lastStats` comparison).

`layout()` takes no "previous result" parameter. An earlier design accepted one as a hint, but it was removed because a parameter the engine would ignore-or-mistrust violates the [loud-seams](#66-loud-seams) rule. The instance cache replaced the hint with a stronger guarantee: warm output is *provably identical* to cold output.

---

## 4. The Data Model

### 4.1 Input: A Document

```ts
// src/types.ts
export interface SemanticDoc {
  blocks: Block[]
  /**
   * REQUIRED document default font, supplied by the adapter — defaults
   * live at the edges, never in the engine. Feeds empty-line metrics.
   */
  baseStyle: TextStyle
}
```

Blocks form a **discriminated union** on `kind`. Both current members carry text runs:

```ts
// src/types.ts
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
```

> [!NOTE]
> Convention: new block types *extend the union*. Code must never hardcode one kind end-to-end. See [Adding a Block Type](#111-adding-a-block-type) for the recipe.

A `Run` is styled text:

```ts
// src/types.ts
export interface Run {
  text: string
  style: TextStyle
}

export interface TextStyle {
  fontFamily: string
  fontSize: number
  bold?: boolean
  italic?: boolean
  /** Line-height multiplier, default 1.0 — see Half-Leading below. */
  lineHeight?: number
}
```

Per-block layout behavior lives in an optional `FlowPolicy`. Its field names deliberately mirror OOXML (`w:keepNext`, `w:keepLines`, ...) for a future DOCX round-trip. `null` counts as **unset** everywhere, because JSON round-trips of attribute maps use `null` for absent attributes: a `.tensor` file containing `flow: { keepNext: null }` must mean "no bond", never an error.

```ts
// src/types.ts
export interface FlowPolicy {
  keepLines?: boolean        // atomic placement: never split this block
  widowControl?: boolean    // widow/orphan protection; false = natural split
  keepNext?: boolean        // BOND to the next block (A→B)
  keepPrevious?: boolean    // BOND to the previous block — same bond, second spelling
  breakBefore?: 'page' | null // structural: force a page break before
  breakAfter?: 'page' | null   // structural: force a page break after
}
```

`LayoutOptions` carries page size, margins, and one document-level default:

```ts
// src/types.ts
export interface LayoutOptions {
  page: { width: number; height: number }
  margins: { top: number; right: number; bottom: number; left: number }
  preventWidowsAndOrphans?: boolean  // default true; per-block flow overrides
}
```

### 4.2 Output: Positioned Facts

The engine's contract: **consumers never derive geometry.** Everything a renderer or editor needs is a *positioned fact* in the output.

```ts
// src/types.ts
export interface LayoutResult {
  pages: PageGeometry[]
  /** Document order. */
  lines: LineBox[]
  breaks: FragmentBreak[]
  /**
   * Cheap staleness signal, NOT a guarantee of change. Bumps ONLY when
   * a call performed any re-break/re-walk; a fully-cache-served call
   * keeps version.
   */
  version: number
}
```

A `LineBox` is one line of text, placed:

```ts
// src/types.ts
export interface LineBox {
  blockId: string
  lineIndex: number   // 0-based within the block, continuous across pages
  pageIndex: number
  rect: Rect          // relative to the page's content box
  baseline: number
  rangeStart: number  // offsets into the block's concatenated run text
  rangeEnd: number
  segments: LineSegment[]  // run boundaries survive breaking
}
```

Two fields deserve explanation for anyone new to text layout:

- **baseline**: the y-position (from the line's top) where text "sits". Glyphs in a line are aligned on this invisible line, and a caret is drawn at the baseline height.
- **`rangeStart`/`rangeEnd`**: plain character offsets into the block's runs joined in array order. They name *source positions*: an edit before an offset shifts it, so they are not stable identities. Every offset-carrying field documents this in a comment, per the working rules in [§10](#10-working-rules).

`FragmentBreak` is emitted **only** when a block splits mid-block:

```ts
// src/types.ts
export interface FragmentBreak {
  blockId: string
  /**
   * Pin: emitted ONLY when a block splits mid-block. atLine = the
   * lineIndex of the block's first line on pageIndex (the line that
   * begins the new page); atLine >= 1 always. A block pushed wholly to
   * a new page emits NO FragmentBreak.
   */
  atLine: number
  pageIndex: number
}
```

> [!IMPORTANT]
> **Immutability contract (enforced, not just documented):** the engine shares cached `LineBox`/`FragmentBreak` objects across results (zero-copy) and `Object.freeze`s every emitted record, its `rect`, and its `segments`. Mutating output corrupts the cache *and* parity.

---

## 5. Measurement: The TextMetrics Port

The engine consumes measurement; it never performs it. The port:

```ts
// src/types.ts
export interface TextMetrics {
  /** Advance width of `text` under `style`, in px. */
  measure(text: string, style: TextStyle): number
  ascent(style: TextStyle): number
  descent(style: TextStyle): number
}
```

- **Advance width**: how far the pen moves right when drawing the text, which is the width a layout engine cares about.
- **Ascent**: how far glyphs rise *above* the baseline.
- **Descent**: how far they fall *below* it. Ascent + descent is the line's text height.

The real implementation is canvas-based and lives **in the shell repository, never here**. This repo defines the port and consumes it. The engine does no caching of metrics: memoization is the production implementation's job.

For tests there is `tests/fake-metrics.ts`, a pure 20-line ruler:

```ts
// tests/fake-metrics.ts
export const FakeMetrics: TextMetrics = {
  measure: (text) => text.length * 10,        // 10px per character
  ascent: (style) => 0.85 * style.fontSize,
  descent: (style) => 0.25 * style.fontSize,
}
```

Everything in the test suite is computed from these three constants, which is why test expectations can name exact numbers. The two that matter most:

| fontSize | line height (ascent+descent) | used for |
|---|---|---|
| 16 | 13.6 + 4 = **17.6px** | early unit tests, the 300-block script |
| 100 | 85 + 25 = **110px** | slicer/flow/golden fixtures |

On the standard Letter test page (816×1056, 96px margins) the content box is **624×864**, so at 110px per line a fresh page holds $\lfloor 864/110 \rfloor = 7$ lines, referred to everywhere as **cap = 7**. Twelve `"aaaa "` tokens (60 chars, 600px) fill one 624px-wide line.

---

## 6. The Layout Pipeline

`layout()` runs each block through three stages:

```
block.runs ──▶ line-breaker.ts ──▶ LineResult[] ──▶ placement machine ──▶ LineBox[]/FragmentBreak[]
                  (§6.1)                            (§6.2–§6.4, in layout.ts)
```

### 6.1 The Line Breaker

`breakLines(runs, metrics, maxWidth, baseStyle)` turns one block's runs into `LineResult`s: unpositioned lines with measured geometry.

```ts
// src/types.ts
export interface LineResult {
  start: number; end: number   // offsets into the concatenated run text
  segments: LineSegment[]      // run boundaries survive breaking
  width: number                // measured
  height: number               // max box ascent + box descent over runs in line
  baseline: number            // max box ascent (half-leading, §6.1.2)
}
```

The algorithm is deliberately simple[^uax14]: *greedy fill; break at spaces only; trim the space at the break; no hyphenation; hard-split tokens longer than the line.*

```ts
// src/line-breaker.ts
while (start < len) {
  if (lineWidth(start, len) <= maxWidth) {        // rest fits → last line
    lines.push(makeLine(start, len))
    break
  }
  // Largest prefix of the remainder that fits.
  let fit = start
  while (fit < len && lineWidth(start, fit + 1) <= maxWidth) fit++
  if (fit === start) {                            // even one char overflows
    fit = start + 1                               // emit it anyway so layout terminates
    lines.push(makeLine(start, fit))
    start = fit
    continue
  }
  const s = lastSpaceIn(start, fit)
  if (s !== -1) {
    lines.push(makeLine(start, s))  // trim the space at the break
    start = s + 1
  } else {
    lines.push(makeLine(start, fit)) // hard-split the overlong token
    start = fit
  }
}
```

Two implementation details that matter for correctness:

1. **Widths are never assumed per-character additive.** `lineWidth(start, end)` sums the *measured* width of each run's intersection with the range (`metrics.measure(run.text.slice(...))`). Real fonts kern (pair widths differ from the sum of singles), so the breaker measures substrings, not characters.
2. **`lastSpaceIn` excludes the space at `from`**: a space at the line's own start would produce an empty line and an infinite loop. The degenerate corner where a single character is wider than the whole line is handled by emitting it anyway. Termination first, aesthetics never, the same philosophy as rule R6 in [§6.2](#62-the-placement-machine).

<details>
<summary>Worked examples (FakeMetrics, maxWidth 100 → 10 chars), pinned by <code>tests/line-breaker.test.ts</code></summary>

- `"aaa bbb ccc"` (11 chars, 110px) → lines `{0,7}` `"aaa bbb"` and `{8,11}` `"ccc"`. The break space (index 7) is trimmed: it belongs to no line, and the test asserts every *other* character is covered by exactly one line.
- Mixed runs, bold `"foo"` + normal `" bar"` → one line, segments `[{runIndex:0, 0–3}, {runIndex:1, 3–7}]`. Run boundaries survive breaking, so a renderer can restyle fragments.
- A 15-char unbroken token → hard split `{0,10}`, `{10,15}`.

</details>

#### 6.1.1 The Empty-Paragraph Fallback

A block with no text still gets exactly one line (`{0,0}`, empty segments): an editor needs a caret anchor for an empty paragraph. It has no runs to measure, so its height falls back to the **document `baseStyle`**:

```ts
// src/line-breaker.ts
if (len === 0) {
  const ascent = metrics.ascent(baseStyle)
  const descent = metrics.descent(baseStyle)
  const { height, baseline } = halfLeading(ascent, descent, baseStyle)
  return [{ start: 0, end: 0, segments: [], width: 0, height, baseline }]
}
```

The baseStyle must be *supplied by the adapter* (`SemanticDoc.baseStyle` is required) because "defaults live at the edges, never in the engine."

#### 6.1.2 Vertical Metrics and Half-Leading

`lineHeight` scales a run's line box the way CSS line-height does: the added space is split evenly above and below the text ("half-leading"). With ascent $a$, descent $d$, and multiplier $\lambda$:

$$h = (a + d)\,\lambda \qquad\quad b = a + \frac{h - (a + d)}{2}$$

```ts
// src/line-breaker.ts
function halfLeading(ascent: number, descent: number, style: TextStyle) {
  const content = ascent + descent
  const height = content * (style.lineHeight ?? 1.0)
  return { height, baseline: ascent + (height - content) / 2 }
}
```

For a line containing several runs, each run gets its own leading and the line's height is the union of the run boxes (`verticalFor` in `line-breaker.ts`). The load-bearing **invariant**: `lineHeight` absent or `1.0` produces numbers *bit-identical* to the lineHeight-free model, because $(a+d) \cdot 1.0 - (a+d)$ is exactly zero in IEEE arithmetic. `tests/line-breaker.test.ts` pins this with `toBe` (bit equality), not `toBeCloseTo`.

Concrete numbers (FakeMetrics, fontSize 16, $\lambda = 2$): content 17.6 → height 35.2, baseline $13.6 + \frac{35.2 - 17.6}{2} = 22.4$.

### 6.2 The Placement Machine

`placeBlock` in `src/layout.ts` places one block's `LineResult`s starting from a **walk state** and returns line boxes, fragment breaks, and the exit state:

```ts
// src/layout.ts (internal types, not exported)
interface WalkState {
  pageIndex: number
  y: number       // cursor, relative to the page content box
}
```

The **Markov property**, the single most important idea in this repository: the placement of blocks $k..end$ is fully determined by $(\text{state at } k,\ \text{blocks } k..end,\ \text{opts})$ and **nothing else persists across block boundaries**. Nothing hidden flows through the walk. That is what makes the incremental cache's [splicing](#74-splice-the-unchanged-suffix) exact, where an older DOM-based editor could only "fingerprint" content and hope.

Vocabulary:

- A block **fragments** when a page break lands inside it (between its lines).
- An **orphan** is a block's *first* line alone at the bottom of a page.
- A **widow** is a block's *last* line alone at the top of the next page. Both are typographic eyesores that Word-class engines suppress.

For a block of L lines with `k` already placed (`n = L − k` remaining) on page `p` with cursor `y` and remaining height `H`, `fits` is computed by walking the block's **actual** line heights. Mixed font sizes mean mixed heights; never assume uniform. The rules:

```
R0. Whole remainder fits H → place, done.
R1. fits == 0 → close page, re-enter fresh. Only if the page has
    content (y > 0): closing a fresh page is a vacuous move.
R2. ORPHAN: fits == 1 && n > 1 && widowControl (and y > 0) → the
    block's START moves to the next page. Tall blocks too: only the
    START moves; after re-entry it fragments naturally under R4.
R-ATOMIC. k == 0 && flow.keepLines && n <= cap → move the whole
    block to the next page. Tall blocks fall through to R4 — can't
    keep together what can't fit together.
R3. WIDOW: n − fits == 1 && fits > 1 && widowControl (and !bonded) →
    break one line earlier (fits − 1); re-check R2.
R4. EXEMPTION (L > cap): no keep-together attempts, no adjustment of
    intermediate breaks — natural splits. Boundary minimums (R2/R3)
    still apply at the block's edges.
R5. NATURAL SPLIT: place `fits` lines, emit FragmentBreak{blockId,
    atLine: k + fits, pageIndex: p + 1}, continue on the next page.
R6. SAFETY: a fresh page always places at least one line even if it
    overflows — never loop forever.
```

> [!NOTE]
> Three notes a newcomer should internalize:
> - **The `y > 0` guards are loop-freedom.** R1/R2 move a block by "close the page and re-enter". If the block already *starts* a fresh page, the move re-creates the identical situation forever. So moving is only allowed off a page that has content; at `y == 0` the rules fall through (R6 or natural placement) instead of looping.
> - **R3 is skipped when an active bond owns the block's last line** (`!bonded` in the code), see [§6.4](#64-bonds-keepnext-and-keepprevious).
> - **The degenerate corner** (pinned as case #12 in `tests/slicer.test.ts`): on a page that fits exactly two lines (`cap == 2`), a 3-line block cannot satisfy both the orphan and widow minimums. The engine fixes the widow and deliberately sacrifices the orphan, because *loop-freedom and determinism outrank a minimum that cannot be honored*. A test pins this corner so any future change there is a deliberate red→green, not silent drift.

Everything in this section is exercised digit-for-digit by the 12 cases of `tests/slicer.test.ts` using fontSize-100 blocks (110px lines, cap 7).

<details>
<summary>Worked example: the widow adjust (slicer case 3)</summary>

A 3-line filler then a 5-line block: only 4 of the block's lines fit page 0's remainder. Natural would split 4/1, leaving the block's last line alone at the top of page 1 (a widow). R3 breaks one line earlier: 3/2, with `FragmentBreak {atLine: 3, pageIndex: 1}`.

</details>

### 6.3 Forced Page Breaks

`breakBefore`/`breakAfter` are applied by the walk driver, outside `placeBlock`:

- `breakBefore: 'page'` closes the page before the block *if* `y > 0` (starting a fresh page already is a no-op).
- `breakAfter: 'page'` closes the page after the block.

Properties, pinned by `tests/flow.test.ts`:

- **Never an empty page.** Closes only happen on pages that hold content, and a *trailing* close (e.g. `breakAfter` on the last block) never materializes a phantom page, because the `pages` array is *derived* after the walk from the maximum line pageIndex rather than accumulated during it.
- Forced breaks emit **no FragmentBreak**: they are not mid-block splits.
- They sit at **precedence tier 1**, see [§6.4.3](#643-precedence).

### 6.4 Bonds: keepNext and keepPrevious

`bond(A→B)` means: **A's last line and B's first line share a page.** One mechanism, two spellings: `keepNext` on A or `keepPrevious` on B. `keepNext` on the last block or `keepPrevious` on the first is a no-op, because no counterpart exists.

#### 6.4.1 Detection by Lookahead

The bond is enforced **during A's placement**, by predicting where B's *first line* will land given A's exit state. The prediction (`firstLineLands`) mirrors the placement machine's start-decisions exactly, including the degenerate arm:

```ts
// src/layout.ts
//   - structural breakBefore: y > 0 → the page closes → next page.
//   - R0: the whole block fits → stays.
//   - fits == 0: y > 0 → R1 closes → next page; y == 0 → R6 places
//     the first line by fiat on the entry page → STAYS (degenerate:
//     a single line taller than the page still lands on the entry
//     page — the bond HOLDS).
//   - R2 orphan: fits == 1 && n > 1 && control && y > 0 → next page.
//   - R-ATOMIC: keepLines && n <= cap while the block doesn't fit →
//     next page.
//   - otherwise: R3-adjusted/R5 splits place fits >= 1 FIRST lines on
//     the entry page → stays (R3 never moves the start).
```

The prediction needs B's first-line height, fetched from the line cache on demand, so the cache absorbs the lookahead cost.

#### 6.4.2 Enforcement Shapes

Bounded: **ONE attempt per bond per call.** When the bond is violated:

- **Shape 1, A fits a fresh page and entered mid-page (`y > 0`)**: move A's start (R1 shape): close the page, re-place A fresh. If the bond is *still* violated after the move, it **drops**. A stays at the moved page: a move that changes nothing is deterministic, and reverting would buy no additional guarantee.
- **Shape 2, A is tall**: back A's *final* split point up one line (R3 shape), so A's last line opens the page where B's first line will land. Floor: a single-line final fragment cannot back up, so the bond drops.
- **Vacuous**: A already starts a fresh page, so moving is vacuous and the bond drops (same give-up family as the `y > 0` guards).

#### 6.4.3 Precedence

```
structural forced breaks  >  orphan move (R2)  >  bond  >  widow adjust (R3)
```

`keepLines` on the *successor* sits with orphan in tier 2: a successor start-move fires first, then the bond cascades the predecessor onto the successor's fresh page. If the move re-triggers, the bond drops (bounded). A bond preempts R3: when the bond already relocates A's last line onto B's page, the widow concern is void.

Two composed cases in `tests/flow.test.ts` pin the subtle interactions:

- **Structural drop → widow re-fire** (6/2, never 7/1): A (8 lines, keepNext), B (3 lines, `breakBefore: 'page'`). The bond drops at detection, because a page that must start with B cannot also start with A's last fragment, *and control returns to R3*: A splits 6/2, never 7/1. The bug this guards against: a dropped bond *and* a widow, the worst of both worlds.
- **R2 re-fire after cascade → bounded drop** (pages of 1/6/3 lines): A moves for the bond; B re-enters and orphan-moves anyway; A already used its one move, so the bond drops and A stays. The bug this guards against: unbounded re-move loops, reverts, or B stranded mid-page.

#### 6.4.4 Chains and the Suffix Rule

Consecutive bonds form a group, and shape-1 moves **cascade backward**: moving B for `bond(B→C)` retro-violates `bond(A→B)`, so A enforces in turn and the chain re-flows. When the cascade reaches a block that already starts a fresh page (vacuous), the engine **drops the earliest bond**, honoring the maximal *suffix* of the chain, and re-flows. The file comments record why this exact tie-break:[^word]

> "Tensor's pinned choice — Word's exact tie-break here is undocumented; this is our spec of record."

The flagship example is **golden case 3** (`tests/golden.test.ts`): a 5-line filler, a 2-line heading with `keepNext`, a 10-line paragraph, all fontSize 100. Without the bond the heading strands at page 0's bottom; with it, the heading moves fresh to page 1, the paragraph's first 5 lines follow it, and its last 5 open page 2: three pages of **5/7/5** lines and one `FragmentBreak {atLine: 5, pageIndex: 2}`, committed as a snapshot for hand-checking.

### 6.5 Headings

Headings route through `breakLines` and the placement machine exactly like paragraphs: they produce real `LineBox`es, flow with bonds, and can be orphan-pushed. `level` is *not* a layout input yet; level-based default styles arrive from the **adapter** (the engine stores level, it does not interpret it). A comment at the routing site marks this seam as pending adapter-side styling.

### 6.6 Loud Seams

Any unimplemented API surface **throws**, never silently no-ops. There are currently none left: `keepNext`, `keepPrevious`, `breakBefore`, and `breakAfter` are all implemented, and their original throw tests were replaced by behavior tests (a deliberate spec change recorded in the commit, not a weakening: tests follow the truth). If you add a future seam (e.g. `breakBefore: 'evenPage'`), throw loudly and pin it with a test.

---

## 7. The Incremental Cache

Layout is a pure function, so a warm engine can memoize aggressively, **provided** warm output stays identical to cold output.

### 7.1 The Parity Law

> [!IMPORTANT]
> The engine instance may memoize; warm output must deep-equal cold output, verified by the [fuzzer](#9-testing-strategy), forever.

`tests/parity.fuzz.test.ts` is the enforcement: a hand-rolled seeded PRNG (mulberry32, no dependencies)[^mulberry32] generates random documents, with mixed font sizes, mixed `lineHeight`s in $\{1.0, 1.5, 2.0\}$, occasional headings, and the full flow menu, then applies 15 random edit operations (insert / delete / edit / swap-adjacent / opts toggle) per sequence. After **every** op, the warm engine's output must deep-equal a fresh cold engine's output (`version` excluded). 40 sequences, fixed seeds `1001..1040`; a failure prints its seed. The corpus has changed deliberately twice (once for flow policy, once for `lineHeight`): seeds stay, sequences shift, and that is stated in the commit.

The fuzzer has caught two real cache bugs already, see [§7.7](#77-the-two-fuzzer-catches). It is a test that must pass forever, not a debug flag for suspected staleness.

### 7.2 What Is Cached

The walk/line caches live in the engine instance, never in `LayoutResult`. One cache is deliberately **module-level**: the block hash identity cache is a `WeakMap` shared by every engine in the process, because hashing is a pure function of the block object and there is nothing instance-specific to isolate.

- **`lineCache`**: `blockId → {contentHash, maxWidth, LineResult[]}`, the expensive text-breaking work, re-validated by content hash and content width.
- **`walkCache`**: one entry per block, in document order:

```ts
// src/layout.ts (internal types, not exported)
interface WalkCacheEntry {
  blockId: string
  contentHash: string
  entryState: WalkState      // where this block entered
  lineBoxes: LineBox[]
  breaks: FragmentBreak[]
  exitState: WalkState       // the MACHINE exit (see §7.6)
  /**
   * UPSTREAM-DEPENDENCE RECORD: whether this placement consumed its
   * successor's first-line height (an ACTIVE bond lookahead at cache
   * time). ...
   */
  bonded: boolean
}
```

- **Context hashes**: `optsHash` + `baseStyleHash`. A change in either (different page size, margins, widow default, or document default font) drops *both* caches wholesale and bumps `cacheEpoch`. The first call is not "invalidation": there was nothing to drop.

`contentHash` is a hand-rolled **stable stringify** (sorted keys, `undefined`-valued keys dropped) of `{kind, runs (text + style), flow}`, everything that determines a block's lines and placement. That is more than "runs+styles": `flow` moves blocks, and `kind` decides whether a block produces lines at all. Block *ids* are not hashed; they are compared separately.

**The hash identity cache.** Stringifying every block on every call is the warm-path's biggest remaining cost, so `hashBlock` memoizes the hash **on the block object itself**:

```ts
// src/layout.ts
// ADAPTER CONTRACT: the shell must reuse unchanged Block objects
// BY REFERENCE across layout calls ... a mutated block must
// be a NEW object (or the stale hash would be trusted — the parity
// fuzzer plus the hash-identity tests pin both directions).
const blockHashCache = new WeakMap<Block, string>()

function hashBlock(block: Block): string {
  let hash = blockHashCache.get(block)
  if (hash === undefined) {
    hash = stableStringify({ /* kind, runs, flow */ })
    blockHashCache.set(block, hash)
  }
  return hash
}
```

A `WeakMap` means dropped blocks don't leak. The contract's two directions are pinned by `tests/hash-identity.test.ts` against the `perf-71.json` 71-page stress fixture:

- **Reference-reused blocks hit the cache**: a re-layout of the unchanged doc stringifies nothing and walks nothing.
- **New/mutated objects re-hash**: a rebuilt block object pays the stringify again (correct, just unshared), and a block replaced by a genuinely new object is detected as changed.

For validation of this cache, `layout.ts` exports temporary instrumentation, `hashCallCount` / `resetHashCallCount()` (module-level, not on the public API), counting stringify misses. The source marks it as temporary, to be removed once the cache is done being validated live.

### 7.3 Resume: The Unchanged Prefix

Per call, the driver computes `resume` = the first index where `[id, contentHash]` differs between the document and the cache. Everything before `resume` is reused outright, justified by:

> **Lemma 1**: unchanged blocks + identical entry states ⇒ identical outputs.

...and by the Markov property from [§6.2](#62-the-placement-machine): since a block's placement depends only on its entry state, its own content, and opts, an unchanged prefix with matching states *must* reproduce its cached output.

### 7.4 Splice: The Unchanged Suffix

While walking block `i`, the driver attempts a **splice**: if the walk cursor equals `walkCache[i+1].entryState` *and* the id and hash verify, the cached remainder can be consumed wholesale. The gate comment is the load-bearing sentence of the whole cache:

```ts
// src/layout.ts
// SPLICE GATE. Consume cached entries while (entry state AND
// id AND contentHash) verify. PROOF-PINNING: exact === on the
// state floats is sound ONLY because warm and cold walks
// execute the identical operation sequence (same y-cursor
// additions, same order, same values); IEEE guarantees
// bitwise-identical results. A refactor that reorders
// accumulation breaks this proof silently — the parity fuzzer
// is the tripwire. A gate FAILING on reordered accumulation is
// merely a missed splice (safe); a gate passing on unequal
// states is impossible under ===.
```

In plain terms: comparing floats with `===` is normally suspect, but here both sides ran the *same additions in the same order on the same values*, and IEEE arithmetic guarantees identical results.[^ieee] There is no epsilon: an epsilon could admit a *wrong* splice, while a failed gate only ever costs performance.

> [!WARNING]
> The proof is exactness-sensitive: a refactor that reorders float accumulation (summing line heights in a different order, batching differently) breaks it **silently**. The gate itself stays safe, only performance degrades. The [parity fuzzer](#71-the-parity-law) is the tripwire that catches any such drift.

Two splice-end rules protect bond context:

- **The splice may not end on a bonded predecessor.** A consumed entry whose placement consumed its successor's first-line height is stale if the successor was *not* also consumed (it changed). The driver un-consumes trailing bonded entries, and the walk re-places them with a fresh lookahead.
- The gate tests **both** the current bond flags *and* the cached `bonded` record: a bond that existed at cache time may have been *removed* by the edit (the flags no longer show it), and a newly-*added* bond requires enforcement the cached placement never performed.

### 7.5 Backward-Resume Through Bonds

Symmetric rule at the *front* boundary: resume extends **backward** while the predecessor is bonded to it. A bonded predecessor's placement consumed its successor's first-line height, so an edit inside the successor can invalidate the predecessor too. Again, both signals are tested (current flags *or* cached `bonded` record). `blocksWalked` counts the re-walked predecessors.

Pinned by `tests/incremental.test.ts`: a hash-only edit inside the successor yields `blocksWalked: 2` (predecessor + successor), while an edit *before* an unchanged bonded pair splices straight through it (`blocksSpliced: 5`).

### 7.6 Cursor Reconstruction

A `breakAfter` close is applied **after** placement as a *cursor transform*: the cached `exitState` is the raw machine exit. Every path that resumes the cursor from a cached exit must re-apply the close:

```ts
// src/layout.ts
function cursorAfter(block: Block, exit: WalkState): WalkState {
  if (block.flow?.breakAfter === 'page') {
    return { pageIndex: exit.pageIndex + 1, y: 0 }
  }
  return exit
}
```

This bit the engine once (a fuzzer-caught parity hole): the splice consumed a cached exit without the close, and the next block walked into a stale mid-page state. `cursorAfter` is applied at splice consume, splice pull-back restore, and walk start reconstruction.

### 7.7 The Two Fuzzer Catches

A short bug retrospective, collapsed by default. Both were found by replaying a failing seed with a small debug harness (the seed is printed in the assertion message), reproducing the divergence, and reading the first differing line box. That workflow (replay, dump, fix, delete the harness) is the intended response to any future `PARITY FAIL seed=…`.

<details>
<summary>Replay: the two cache holes the fuzzer caught</summary>

1. **Splice ended on a bonded predecessor** whose successor was the next *edited* block: stale bond context, warm ≠ cold. Fix: the splice pull-back described in [§7.4](#74-splice-the-unchanged-suffix).
2. **`cursorAfter` missing** at splice consume: a `breakAfter` block consumed from cache left the cursor mid-page. Fix: [§7.6](#76-cursor-reconstruction).

</details>

### 7.8 Statistics and Version

`engine.lastStats` (debug surface, rebuilt from scratch every call):

```ts
// src/types.ts
export interface LastStats {
  blocksWalked: number    // placed through the machine (cache hits count)
  linesRebroken: number   // breakLines() invocations (lineCache misses)
  blocksSpliced: number   // cached entries consumed by verified splice
  cacheEpoch: number      // +1 per wholesale invalidation; 0 in a fresh engine
  invalidated: boolean    // context change dropped the caches this call
}
```

The scripted 300-block scenario in `tests/incremental.test.ts` pins the point of all this machinery: after a hash-only edit of block 250, the warm engine reports `{blocksWalked: 1, linesRebroken: 1, blocksSpliced: 49}`. One block of work instead of 300, same bytes out.

`LayoutResult.version` starts at 1 and bumps only when a call did work (any walk, re-break, or invalidation) after the first call. A fully cache-served call keeps it. It is a *cheap staleness signal*, not a change guarantee.

---

## 8. How the Pieces Prove Each Other

Three ideas, stated plainly:

1. The **Markov property** ([§6.2](#62-the-placement-machine)) makes each block's placement a function of visible inputs only. It is why a cached placement can be reused once its entry state is verified: there is nothing hidden to go stale.
2. **Lemma 1 + exact state equality** ([§7.3](#73-resume-the-unchanged-prefix), [§7.4](#74-splice-the-unchanged-suffix)) turn that into two reuse rules (prefix, splice) whose failure mode is *missed reuse* (slower), never wrong output.
3. The **parity fuzzer** ([§7.1](#71-the-parity-law)) closes the loop by *executing* the claim "warm ≡ cold" over randomized edit sequences, forever. Any hidden state, stale consumption, or float nondeterminism becomes a red seed, not a mystery.

The same philosophy recurs at smaller scale: the degenerate corner is pinned ([§6.2](#62-the-placement-machine)), placeholders are pinned until replaced ([§6.1.1](#611-the-empty-paragraph-fallback)), and a mutation test (comment out the backward-resume and watch `tests/incremental.test.ts` fail with `expected 1 to be 2`) demonstrates that the rules are *enforced by tests*, not merely documented.

---

## 9. Testing Strategy

The repo is test-first: every behavior lands with a test that failed before it, and tests are never weakened to pass.

| File | Role |
|---|---|
| `tests/fake-metrics.ts` | the pure ruler ([§5](#5-measurement-the-textmetrics-port)); not itself a test |
| `line-breaker.test.ts` | 8 cases: core breaker pins, contiguity property, lineHeight model + bit-exact invariant |
| `layout.test.ts` | measured line boxes, multi-line stacking, cross-block y, empty-paragraph baseStyle fallback |
| `slicer.test.ts` | 12 cases pinning R0–R6 + R-ATOMIC, incl. the cap-2 degenerate corner |
| `flow.test.ts` | 14 cases: bonds (both spellings × both shapes), 3-chain cascade, suffix rule, forced breaks, no empty pages, structural drops, the two composed precedence cases |
| `incremental.test.ts` | cache stats: 300-block script (1/1/49), insert/delete/swap/opts-toggle counts, epoch 0→1, bonded re-walk, splice-through-bond |
| `golden.test.ts` | 3 committed snapshots (see below) |
| `parity.fuzz.test.ts` | the parity law, 40 seeds × 15 ops |
| `hash-identity.test.ts` | the hash identity cache, both directions of the adapter contract, on the 71-page fixture |
| `purity.test.ts` | src/ bans DOM/canvas/react references |

`tests/perf-71.json` is the canonical **71-page stress document**, generated by `tests/gen-perf71.ts`: a seeded LCG picks block lengths/kinds/flow, and blocks are appended until the real engine (FakeMetrics) measures exactly 71 pages. Regeneration is byte-identical and follows the same "intentionally, never casually" discipline as goldens; the generator is run via `tsx` from the shell checkout (this repo has no tsx dependency).

> [!WARNING]
> **Golden snapshots** are committed and CI fails if missing. They are regenerated *intentionally, never casually*: the deliberate regeneration is announced, the `.snap` git diff is printed for human hand-check, and any test whose fixture didn't contain the changed feature must show a zero-diff. The three current cases: (1) a single paragraph on Letter, the measured-numbers case (width 140, height 17.6, baseline 13.6 for "Hello, Tensor."); (2) a 10-line fontSize-100 block, 7+3 lines across two pages with one FragmentBreak; (3) the bonded-heading flagship, 5/7/5 ([§6.4.4](#644-chains-and-the-suffix-rule)).

Worked-example numbers appear throughout the suite because FakeMetrics makes them exact. If you add tests, prefer fonts and lengths whose heights divide evenly into 864 (110px lines × cap 7 is the workhorse).

---

## 10. Working Rules

The rules below govern humans and AI contributors alike. They are enforced socially and by tests; several are pinned mechanically (parity, purity, degenerate corners).

<details>
<summary>The full working-rules list</summary>

- TypeScript only. No new runtime dependency without explicit approval.
- The layout core is pure: no DOM/window/canvas in `src/`. All measurement goes through the injected metrics port.
- Unimplemented API surface throws loudly; it never silently no-ops. JSON `null` counts as unset.
- Test-first: every bug fix lands with a test that failed before the fix. Never weaken a test to make it pass.
- Known-wrong placeholders are pinned by tests; replacing one is a deliberate red → green, never a silent change.
- One behavior per commit. Diffs touching >3 files need a stated reason.
- Blocks form a union with a `kind` discriminator. New block types extend the union; never hardcode one kind end-to-end.
- Line boxes are positioned facts in the output. Consumers never derive geometry.
- Fragments of a block share its id; `lineIndex` is continuous across pages.
- A bonded block's placement consumes its successor's first-line height (upstream dependence). Resume points and splice endpoints extend backward through bonds; a splice never ends on a bonded predecessor.
- Flow precedence tiers: structural forced breaks > orphan/atomic start-moves > bond > widow adjust, as a bounded re-check loop over the R6 floor.
- Parity law: the engine instance may memoize; warm output must deep-equal cold output, verified by the fuzzer forever.
- Treat `LayoutResult` as immutable: the engine shares cached records across results (zero-copy) and freezes them; a caller mutating them corrupts the cache and parity.
- `engine.lastStats` is debug surface, not API.
- Any field encoding a document position declares, in a comment, how it survives edits.
- Golden tests live in `tests/`. Regenerate intentionally, never casually.

</details>

The shell pairing adds three two-sided laws (each is a contract only as a pair):

- **Two-sided law**: the engine computes, never paints; the shell paints, never computes. The handoff between them is pure data: `LayoutResult` positioned facts in, styled glyphs out.
- **One-ruler rule**: one `TextMetrics` instance is the app's single measurement authority, paired with one engine instance for the view's lifetime. Measured widths, painted advances, and caret positions all come from the same ruler.
- **Input-only-view rule**: the shell's hidden editing view is input only. Pixel-to-position questions are answered by the engine's positioned facts, never by re-measuring a DOM that only happens to hold text.

---

## 11. Practical Guides

### 11.1 Adding a Block Type

Extend the union in `types.ts` (e.g. `ListBlock`), give it runs or a line-producing form, and the driver picks it up *if* it can produce lines. Do not add `kind === 'x'` special cases scattered through layout logic: route through the same `breakLines` + `placeBlock` path. Add a flow test and, if output shapes change, a NEW golden case (old ones must not move).

### 11.2 Adding a Layout Feature

The established pattern: write the failing tests first (pin exact FakeMetrics numbers), implement the smallest rule set that satisfies them, encode the ruled semantics and every give-up in comments at the code site, extend the fuzzer's generator if the feature introduces new cross-block dependence, and state any corpus change. If the feature has unimplemented seams, make them throw loudly.

### 11.3 When the Fuzzer Fails

1. Note the printed seed and op.
2. Copy `mulberry32` + the generator into a temporary debug test, replay to the failing op, and dump the document plus the first differing line box.
3. Find which cached assumption went stale (consumption? cursor transform? entry state?), and fix the *rule* (and its comment), not the symptom.
4. Delete the debug harness. The seed is now a permanent regression test.

### 11.4 Verifying a Change

```
npm run typecheck
npm run build
npm test        # twice: snapshots must be stable across runs
git diff tests/__snapshots__/   # must be empty unless you deliberately regenerated
```

The degenerate corner, the composed precedence cases, the parity seeds, the placeholder pins: every ruled behavior in this document is enforced by a named test. A change that violates a pinned rule surfaces as a red test, not silent drift, which is the whole point of this repository's style.

---

[^uax14]: Unicode Standard Annex #14, the Unicode Line Breaking Algorithm. A proper implementation is planned future work; the current breaker is deliberately simple.

[^pm]: ProseMirror's document model reuses unchanged nodes by reference after edits ("structural sharing"), so an edit naturally leaves every untouched block object identical by reference.

[^word]: Microsoft does not document Word's exact keep-with-next tie-break for over-tall chains. Rather than guess, Tensor pins its own rule and declares it the spec of record.

[^mulberry32]: mulberry32, a compact 32-bit seeded PRNG recipe chosen for tiny, dependency-free determinism. Fixed seeds keep failures reproducible forever.

[^ieee]: IEEE 754 requires each individual operation to produce the exact, correctly-rounded result, so an identical sequence of operations on identical values is bitwise reproducible across runs and machines.
