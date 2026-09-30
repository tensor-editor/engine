import { describe, expect, it } from 'vitest'
import { createLayoutEngine } from '../src/index.js'
import { FakeMetrics } from './fake-metrics.js'
import type {
  Block,
  FlowPolicy,
  LayoutOptions,
  LayoutResult,
  SemanticDoc,
  TextStyle,
} from '../src/index.js'

// PARITY FUZZ — the headline guarantee. After every op, the warm engine's
// output must deep-equal a fresh cold engine's output (version
// excluded). This is the old DOM-based system's DEBUG_VERIFY_RECONVERGENCE
// — except it's a test that must pass forever, not a debug flag for
// suspected staleness. Fixed seeds; the failing seed is printed on
// failure.

// mulberry32 — hand-rolled seeded PRNG, no new deps.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    let t = (a += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FONT_SIZES = [16, 24, 32, 100] // mixed heights: 17.6 / 26.4 / 35.2 / 110
const LINE_HEIGHTS = [1.0, 1.5, 2.0] // bottom-only leading model
// Block-tier spacing: occasional values exercise the entry/exit cursor
// padding (fits against line tops, spaceAfter in the exit state).
const SPACING = [20, 110, 300]
// Block-tier indent: occasional values exercise the narrowed wrap width
// + rect.x shift (block geometry, not a run style — hash-covered, so
// an indent edit must re-break/re-place, never serve stale lines).
const INDENTS = [20, 120, 300]
// Right half of the family: narrows the wrap from the right, rect.x
// stays at indentLeft. Continuations keep it — same cache surface.
const INDENT_RIGHTS = [30, 150]
// First-line indent: line 0 gets its own edge AND wrap width. NON-
// NEGATIVE values ONLY here: a negative firstLineIndent under a
// smaller indentLeft is a negative left edge, which the engine's
// loud validation seam correctly REFUSES — and independent draws
// cannot guarantee the pairwise sum ≥ 0. The hanging case (negative
// under a larger indentLeft) is pinned by explicit tests instead.
const FIRST_LINE_INDENTS = [40, 160]
// E-IMG-1: occasional image blocks. Dim menu INCLUDES zero (the
// degenerate 1×1 degrade), sub-pixel, and larger-than-content-box
// (700/1248 > 624 width; 2600 > 864 height — fit-down and R6 floor
// territory). DELIBERATE CORPUS CHANGE: the generator now draws
// images, so the generated sequences differ from the pre-image corpus
// by construction — seeds stay 1001+i; parity is re-established by
// this suite passing.
const IMAGE_DIMS = [0, 1, 50, 200, 624, 700, 1248, 2600]
const IMAGE_ALIGNS = ['left', 'center', 'right'] as const
// E-IMG-3: occasional floats on image blocks. Negatives reach into the
// margins (page-box clamp territory), positives toward/past the far
// edges. DELIBERATE CORPUS CHANGE (with the E-IMG-2 inline draws
// below): the generator now draws floats and inline-image runs, so
// the generated sequences differ from the pre-float corpus by
// construction — seeds stay 1001+i; parity is re-established by this
// suite passing.
const FLOAT_OFFSETS = [-300, -50, 0, 50, 300]
const FLOAT_Z = ['front', 'behind'] as const
const BASE_STYLE: TextStyle = { fontFamily: 'sans-serif', fontSize: 16 }
const BASE_OPTS: LayoutOptions = {
  page: { width: 816, height: 1056 },
  margins: { top: 96, right: 96, bottom: 96, left: 96 },
}

const randInt = (rng: () => number, lo: number, hi: number) =>
  lo + Math.floor(rng() * (hi - lo + 1))

// Flow menu: bonds (keepNext/keepPrevious), forced breaks
// (breakBefore/breakAfter), keep-together, widow-off, or none.
const FLOW_MENU: (FlowPolicy | undefined)[] = [
  { keepLines: true },
  { widowControl: false },
  { keepNext: true },
  { keepPrevious: true },
  { breakBefore: 'page' },
  { breakAfter: 'page' },
  undefined,
]

function randomBlock(rng: () => number, id: string): Block {
  const flow = FLOW_MENU[Math.floor(rng() * FLOW_MENU.length)]
  // E-IMG-1: ~15% of blocks are images (atomic placements; the flow
  // menu rides them like any block — bonds on/from images, forced
  // breaks, keepLines vacuous-but-harmless). Indents are drawn for
  // images too: ignored at placement, still hash-covered.
  if (rng() < 0.15) {
    return {
      id,
      kind: 'image',
      src: `media://${id}-${randInt(rng, 0, 999)}`,
      width: IMAGE_DIMS[randInt(rng, 0, IMAGE_DIMS.length - 1)],
      height: IMAGE_DIMS[randInt(rng, 0, IMAGE_DIMS.length - 1)],
      ...(rng() < 0.6 ? { align: IMAGE_ALIGNS[randInt(rng, 0, 2)] } : {}),
      alt: `alt ${randInt(rng, 0, 99)}`,
      // E-IMG-3: ~40% of the drawn images are FLOATED (zero flow
      // presence; anchor + (dx, dy) → page-box clamp; z echoes to
      // placed[]). Floats throw on bond/forced-break flow — the
      // post-op sanitizeFloatBonds pass below keeps the corpus legal.
      ...(rng() < 0.4
        ? {
            float: {
              dx: FLOAT_OFFSETS[randInt(rng, 0, FLOAT_OFFSETS.length - 1)],
              dy: FLOAT_OFFSETS[randInt(rng, 0, FLOAT_OFFSETS.length - 1)],
              z: FLOAT_Z[randInt(rng, 0, 1)],
            },
          }
        : {}),
      ...(flow ? { flow } : {}),
      ...(rng() < 0.3 ? { spaceBefore: SPACING[randInt(rng, 0, 2)] } : {}),
      ...(rng() < 0.3 ? { spaceAfter: SPACING[randInt(rng, 0, 2)] } : {}),
      ...(rng() < 0.25 ? { indentLeft: INDENTS[randInt(rng, 0, 2)] } : {}),
      ...(rng() < 0.25 ? { indentRight: INDENT_RIGHTS[randInt(rng, 0, 1)] } : {}),
      ...(rng() < 0.2 ? { firstLineIndent: FIRST_LINE_INDENTS[randInt(rng, 0, 1)] } : {}),
    } as Block
  }
  // 1-3 runs of random length; 0-token runs keep the empty-paragraph
  // placeholder path exercised. Occasional heading blocks exercise real
  // heading layout. E-IMG-2: ~20% of runs are INLINE IMAGE OBJECTS —
  // unbreakable single-position tokens mixed into the text runs, dims
  // from the same menu as block images (degenerate 1×1, clamp-wide,
  // page-tall). DELIBERATE CORPUS CHANGE: the sequences differ from the
  // pre-inline corpus by construction; parity is re-established by this
  // suite passing (the run draws shift every subsequent rng draw).
  const runs = Array.from({ length: randInt(rng, 1, 3) }, () => {
    if (rng() < 0.2) {
      return {
        kind: 'inlineImage' as const,
        src: `media://inline-${randInt(rng, 0, 999)}`,
        width: IMAGE_DIMS[randInt(rng, 0, IMAGE_DIMS.length - 1)],
        height: IMAGE_DIMS[randInt(rng, 0, IMAGE_DIMS.length - 1)],
        alt: `inline ${randInt(rng, 0, 99)}`,
      }
    }
    return {
      text: 'aaaa '.repeat(randInt(rng, 0, 8)),
      style: {
        fontFamily: 'sans-serif',
        fontSize: FONT_SIZES[randInt(rng, 0, 3)],
        ...(rng() < 0.5
          ? { lineHeight: LINE_HEIGHTS[randInt(rng, 0, 2)] }
          : {}),
        // M-STYLES: occasional variant-caps draws so fontVariant flows
        // through contentHash and the parity law from day one. FakeMetrics
        // ignores it (width = f(text)), so these blocks are geometrically
        // identical to their variant-free twins — the hash is the only
        // thing that distinguishes them, which is the point. NOTE: this
        // corpus change is DELIBERATE (same fixed seeds, new draws — the
        // generated sequences differ from the pre-fontVariant corpus by
        // construction); parity is re-established by this suite passing.
        ...(rng() < 0.2 ? { fontVariant: 'small-caps' } : {}),
      },
    }
  })
  const kind = rng() < 0.2 ? 'heading' : 'paragraph'
  return {
    id,
    kind,
    ...(kind === 'heading' ? { level: randInt(rng, 1, 4) } : {}),
    runs,
    ...(flow ? { flow } : {}),
    ...(rng() < 0.3 ? { spaceBefore: SPACING[randInt(rng, 0, 2)] } : {}),
    ...(rng() < 0.3 ? { spaceAfter: SPACING[randInt(rng, 0, 2)] } : {}),
    ...(rng() < 0.25 ? { indentLeft: INDENTS[randInt(rng, 0, 2)] } : {}),
    ...(rng() < 0.25 ? { indentRight: INDENT_RIGHTS[randInt(rng, 0, 1)] } : {}),
    ...(rng() < 0.2 ? { firstLineIndent: FIRST_LINE_INDENTS[randInt(rng, 0, 1)] } : {}),
  } as Block
}

interface FuzzState {
  doc: SemanticDoc
  opts: LayoutOptions
  nextId: number
}

type OpKind = 'insert' | 'delete' | 'edit' | 'swap' | 'toggle-opts'

function pickOp(rng: () => number, len: number): OpKind {
  const r = rng()
  if (r < 0.25) return 'insert'
  if (r < 0.45) return len > 1 ? 'delete' : 'insert'
  if (r < 0.75) return 'edit'
  if (r < 0.95) return len >= 2 ? 'swap' : 'insert'
  return 'toggle-opts' // ~10%: exercises wholesale invalidation
}

function applyOp(rng: () => number, state: FuzzState): { kind: OpKind; state: FuzzState } {
  const kind = pickOp(rng, state.doc.blocks.length)
  const doc: SemanticDoc = { baseStyle: state.doc.baseStyle, blocks: [...state.doc.blocks] }
  let opts = state.opts
  switch (kind) {
    case 'insert': {
      const at = randInt(rng, 0, doc.blocks.length)
      doc.blocks.splice(at, 0, randomBlock(rng, `x${state.nextId++}`))
      break
    }
    case 'delete': {
      doc.blocks.splice(randInt(rng, 0, doc.blocks.length - 1), 1)
      break
    }
    case 'edit': {
      const at = randInt(rng, 0, doc.blocks.length - 1)
      const target = doc.blocks[at]
      const roll = rng()
      if (target.kind === 'image') {
        // Image edits, five hash-relevant surfaces: src/alt are
        // OPAQUE ECHOES (the alt-edit op is LOAD-BEARING — placed[]
        // echoes alt, so a stale spliced echo would break parity;
        // pinned here and by tests/image.test.ts #6), dims are
        // geometry, align is placement, and (E-IMG-3) float toggling
        // exercises the anchor/rect derivation and the dx/dy/z echo.
        if (roll < 0.2) {
          doc.blocks[at] = { ...target, src: `${target.src}-x` }
        } else if (roll < 0.4) {
          doc.blocks[at] = { ...target, alt: `${target.alt} (edited)` }
        } else if (roll < 0.6) {
          doc.blocks[at] = {
            ...target,
            width: IMAGE_DIMS[randInt(rng, 0, IMAGE_DIMS.length - 1)],
            height: IMAGE_DIMS[randInt(rng, 0, IMAGE_DIMS.length - 1)],
          }
        } else if (roll < 0.8) {
          doc.blocks[at] = { ...target, align: IMAGE_ALIGNS[randInt(rng, 0, 2)] }
        } else if (target.float === undefined) {
          doc.blocks[at] = {
            ...target,
            float: {
              dx: FLOAT_OFFSETS[randInt(rng, 0, FLOAT_OFFSETS.length - 1)],
              dy: FLOAT_OFFSETS[randInt(rng, 0, FLOAT_OFFSETS.length - 1)],
              z: FLOAT_Z[randInt(rng, 0, 1)],
            },
          }
        } else {
          // Clear the float (undefined ≡ absent for the hash — the
          // stableStringify undefined-dropping rule).
          doc.blocks[at] = { ...target, float: undefined }
        }
      } else if (roll < 0.33) {
        // hash-only: same length, same heights, different content.
        // E-IMG-2: inline-image runs carry no text — the edit skips
        // them (the segment/token surfaces cover their cache paths).
        doc.blocks[at] = {
          ...target,
          runs: target.runs.map((r) =>
            r.kind === 'inlineImage' ? r : { ...r, text: r.text.replace(/a/g, 'c') },
          ),
        }
      } else if (roll < 0.66) {
        // height-changing: entirely new random content, same id
        doc.blocks[at] = randomBlock(rng, target.id)
      } else {
        // flow-changing: set/clear a random flow policy — bonds and
        // forced breaks included.
        doc.blocks[at] = { ...target, flow: FLOW_MENU[Math.floor(rng() * FLOW_MENU.length)] }
      }
      break
    }
    case 'swap': {
      const at = randInt(rng, 0, doc.blocks.length - 2)
      const first = doc.blocks[at]
      doc.blocks[at] = doc.blocks[at + 1]
      doc.blocks[at + 1] = first
      break
    }
    case 'toggle-opts': {
      opts = { ...state.opts, preventWidowsAndOrphans: !state.opts.preventWidowsAndOrphans }
      break
    }
  }
  // FLOAT-BOND SANITIZE (E-IMG-3): the engine's float flow seam THROWS
  // on any bond or forced break touching a floated image (ruled loud
  // seam, see tests/float.test.ts #e). The generator draws flow and
  // float independently, so an op can produce an illegal combo (a
  // random flow menu pick on a floated image, a swap moving a bonded
  // block next to one). Rather than narrow the generator's menus, this
  // post-op pass clears the offending flags — copy-on-write, because
  // blocks are immutable by contract and mutating one in place would
  // betray the identity hash cache. DELIBERATE corpus shaping: bonds
  // among text/block-image blocks still fuzz at full strength; the
  // float seam itself is pinned by the dedicated tests.
  doc.blocks = sanitizeFloatBonds(doc.blocks)
  return { kind, state: { doc, opts, nextId: state.nextId } }
}

// True when the block is a floated image (E-IMG-3).
const isFloated = (block: Block): boolean =>
  block.kind === 'image' && block.float !== undefined

// Strip the float-illegal flow keys (bonds + forced breaks); keep the
// vacuous-legal ones (keepLines/widowControl, the block-image
// precedent). Returns undefined when nothing legal remains.
function stripFloatIllegalFlow(flow: FlowPolicy | undefined): FlowPolicy | undefined {
  if (flow === undefined) return undefined
  const kept: FlowPolicy = { ...flow }
  delete kept.keepNext
  delete kept.keepPrevious
  delete kept.breakBefore
  delete kept.breakAfter
  return kept.keepLines !== undefined || kept.widowControl !== undefined ? kept : undefined
}

function stripFlowKeys(flow: FlowPolicy | undefined, keys: ('keepNext' | 'keepPrevious')[]): FlowPolicy | undefined {
  if (flow === undefined) return undefined
  const kept: FlowPolicy = { ...flow }
  for (const key of keys) delete kept[key]
  const rest = Object.keys(kept).filter((key) => kept[key as keyof FlowPolicy] !== undefined)
  return rest.length > 0 ? kept : undefined
}

function sanitizeFloatBonds(blocks: Block[]): Block[] {
  let out = blocks
  const setBlock = (i: number, block: Block): void => {
    if (out === blocks) out = [...blocks]
    out[i] = block
  }
  for (let i = 0; i < out.length; i++) {
    const a = out[i]
    const b = out[i + 1]
    const aFloat = isFloated(a)
    const bFloat = b !== undefined && isFloated(b)
    // A floated block's own bond/forced-break flags: strip.
    if (aFloat) setBlock(i, { ...a, flow: stripFloatIllegalFlow(a.flow) })
    if (bFloat) setBlock(i + 1, { ...b!, flow: stripFloatIllegalFlow(b!.flow) })
    // A bond between an adjacent pair where either side is floated:
    // strip the flag from whichever side carries it.
    if ((aFloat || bFloat) && b !== undefined) {
      if (a.flow?.keepNext === true) {
        setBlock(i, { ...out[i], flow: stripFlowKeys(out[i].flow, ['keepNext']) })
      }
      if (b.flow?.keepPrevious === true) {
        setBlock(i + 1, { ...out[i + 1], flow: stripFlowKeys(out[i + 1].flow, ['keepPrevious']) })
      }
    }
  }
  return out
}

// placed[] compared too (E-IMG-1): atomic visual placements are part
// of the parity surface. E-IMG-2/3: inline-object segments (inside
// lines, one position per object) and float rects (the float/z echoes
// included) ride the same canonicalization — warm ≡ cold covers the
// full E-IMG-2/3 output shapes.
const canonical = (r: LayoutResult) =>
  JSON.parse(JSON.stringify({ pages: r.pages, lines: r.lines, breaks: r.breaks, placed: r.placed }))

const SEQUENCE_COUNT = 40
const OPS_PER_SEQUENCE = 15
const BASE_SEED = 1001 // fixed forever

// CORPUS COVERAGE RECEIPT (E-IMG-2/3): the generator's inline-image
// and float menus must actually FIRE — a silently-narrowed menu would
// pass parity while exercising neither surface. Counted across every
// op of every sequence (the its below run sequentially in declaration
// order); the closing it asserts both surfaces were exercised.
let corpusInlineRuns = 0
let corpusFloats = 0

describe('parity fuzz: warm engine deep-equals cold engine (parity law)', () => {
  for (let s = 0; s < SEQUENCE_COUNT; s++) {
    const seed = BASE_SEED + s
    it(`sequence ${s} (seed ${seed})`, () => {
      const rng = mulberry32(seed)
      const state: FuzzState = {
        doc: {
          baseStyle: BASE_STYLE,
          blocks: Array.from({ length: 6 + Math.floor(rng() * 9) }, (_, i) =>
            randomBlock(rng, `b${i}`),
          ),
        },
        opts: BASE_OPTS,
        nextId: 1000,
      }
      const warm = createLayoutEngine({ metrics: FakeMetrics })

      let carriedLine: unknown = null
      let carriedValues: number[] = []

      for (let op = 0; op < OPS_PER_SEQUENCE; op++) {
        const applied = applyOp(rng, state)
        state.doc = applied.state.doc
        state.opts = applied.state.opts
        state.nextId = applied.state.nextId

        for (const block of state.doc.blocks) {
          if (block.kind === 'image') {
            if (block.float !== undefined) corpusFloats += 1
          } else {
            corpusInlineRuns += block.runs.filter((r) => r.kind === 'inlineImage').length
          }
        }

        const warmResult = warm.layout(state.doc, state.opts)
        const coldResult = createLayoutEngine({ metrics: FakeMetrics }).layout(state.doc, state.opts)

        expect(
          canonical(warmResult),
          `PARITY FAIL seed=${seed} op=${op} (${applied.kind})`,
        ).toEqual(canonical(coldResult))

        // Immutability enforcement: emitted records are frozen.
        if (warmResult.lines.length > 0) {
          expect(Object.isFrozen(warmResult.lines[0])).toBe(true)
          expect(Object.isFrozen(warmResult.lines[0].rect)).toBe(true)
        }
        if (warmResult.breaks.length > 0) {
          expect(Object.isFrozen(warmResult.breaks[0])).toBe(true)
        }
        if (warmResult.placed.length > 0) {
          expect(Object.isFrozen(warmResult.placed[0])).toBe(true)
          expect(Object.isFrozen(warmResult.placed[0].rect)).toBe(true)
        }
        expect(Object.isFrozen(warmResult.pages[0])).toBe(true)

        // Cached entries must not be structurally mutated between
        // calls (zero-copy sharing): the previous call's first LineBox,
        // when carried over by identity, still holds its previous values.
        const carried =
          carriedLine !== null
            ? warmResult.lines.find((l) => l === carriedLine)
            : undefined
        if (carried) {
          expect([
            carried.pageIndex,
            carried.rect.y,
            carried.rect.height,
            carried.rect.width,
          ]).toEqual(carriedValues)
        }
        if (warmResult.lines.length > 0) {
          const first = warmResult.lines[0]
          carriedLine = first
          carriedValues = [first.pageIndex, first.rect.y, first.rect.height, first.rect.width]
        }
      }
    })
  }

  it('corpus coverage receipt: inline-image runs and floats both exercised', () => {
    expect(corpusInlineRuns).toBeGreaterThan(0)
    expect(corpusFloats).toBeGreaterThan(0)
  })
})
