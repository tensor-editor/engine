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
  // 1-3 runs of random length; 0-token runs keep the empty-paragraph
  // placeholder path exercised. Occasional heading blocks exercise real
  // heading layout.
  const runs = Array.from({ length: randInt(rng, 1, 3) }, () => ({
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
  }))
  const kind = rng() < 0.2 ? 'heading' : 'paragraph'
  const flow = FLOW_MENU[Math.floor(rng() * FLOW_MENU.length)]
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
      if (roll < 0.33) {
        // hash-only: same length, same heights, different content
        doc.blocks[at] = {
          ...target,
          runs: target.runs.map((r) => ({ ...r, text: r.text.replace(/a/g, 'c') })),
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
  return { kind, state: { doc, opts, nextId: state.nextId } }
}

const canonical = (r: LayoutResult) =>
  JSON.parse(JSON.stringify({ pages: r.pages, lines: r.lines, breaks: r.breaks }))

const SEQUENCE_COUNT = 40
const OPS_PER_SEQUENCE = 15
const BASE_SEED = 1001 // fixed forever

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
})
