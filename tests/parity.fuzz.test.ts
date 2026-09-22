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

// PARITY FUZZ — THE M3 HEADLINE. After every op, the warm engine's
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
const BASE_STYLE: TextStyle = { fontFamily: 'sans-serif', fontSize: 16 }
const BASE_OPTS: LayoutOptions = {
  page: { width: 816, height: 1056 },
  margins: { top: 96, right: 96, bottom: 96, left: 96 },
}

const randInt = (rng: () => number, lo: number, hi: number) =>
  lo + Math.floor(rng() * (hi - lo + 1))

function randomBlock(rng: () => number, id: string): Block {
  // 1-3 runs of random length; 0-token runs keep the empty-paragraph
  // placeholder path exercised.
  const runs = Array.from({ length: randInt(rng, 1, 3) }, () => ({
    text: 'aaaa '.repeat(randInt(rng, 0, 8)),
    style: { fontFamily: 'sans-serif', fontSize: FONT_SIZES[randInt(rng, 0, 3)] },
  }))
  const roll = rng()
  const flow: FlowPolicy | undefined =
    roll < 0.15 ? { keepLines: true } : roll < 0.25 ? { widowControl: false } : undefined
  return { id, kind: 'paragraph', runs, ...(flow ? { flow } : {}) }
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
        // flow-changing
        doc.blocks[at] = {
          ...target,
          flow: (rng() < 0.5 ? { keepLines: true } : { widowControl: false }) as FlowPolicy,
        }
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
