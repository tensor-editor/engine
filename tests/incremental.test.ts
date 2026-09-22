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

const style16: TextStyle = { fontFamily: 'sans-serif', fontSize: 16 }
const style100: TextStyle = { fontFamily: 'sans-serif', fontSize: 100 }
const baseStyle: TextStyle = { fontFamily: 'sans-serif', fontSize: 16 }
const opts: LayoutOptions = {
  page: { width: 816, height: 1056 },
  margins: { top: 96, right: 96, bottom: 96, left: 96 },
}

function para(id: string, text = 'aaaa', style: TextStyle = style16, flow?: FlowPolicy): Block {
  return { id, kind: 'paragraph', runs: [{ text, style }], ...(flow ? { flow } : {}) }
}

// Parity comparison helper: version deliberately excluded.
const canonical = (r: LayoutResult) =>
  JSON.parse(JSON.stringify({ pages: r.pages, lines: r.lines, breaks: r.breaks }))

const cold = (doc: SemanticDoc, o: LayoutOptions = opts) =>
  createLayoutEngine({ metrics: FakeMetrics }).layout(doc, o)

function doc60(): SemanticDoc {
  return {
    baseStyle,
    blocks: Array.from({ length: 60 }, (_, i) => para(`b${i}`)),
  }
}

// 300 one-line blocks (17.6px each; 49 lines/page) with a 20-line
// keepLines block at index 280. Its R-ATOMIC move absorbs downstream
// shifts — the block lands at the top of page 6 at state (6, 352) in
// BOTH the pre-edit and post-edit walks, which is how the
// height-growing test reconverges and splices (uniform-fill docs never
// reconverge organically: a positive y-shift propagates to doc end).
function scriptedDoc(): SemanticDoc {
  const blocks: Block[] = []
  for (let i = 0; i < 300; i++) {
    if (i === 280) {
      blocks.push(para(`b${i}`, 'aaaa '.repeat(240), style16, { keepLines: true }))
    } else {
      blocks.push(para(`b${i}`, 'aaaa'))
    }
  }
  return { baseStyle, blocks }
}

describe('incremental layout (M3)', () => {
  it('scripted 300-block: hash-only edit walks 1, splices 49, rebreaks 1', () => {
    const doc = scriptedDoc()
    const engine = createLayoutEngine({ metrics: FakeMetrics })

    const first = engine.layout(doc, opts)
    expect(first.version).toBe(1)
    expect(engine.lastStats.blocksWalked).toBe(300) // cold full walk

    // Identical call: fully cache-served — version kept, nothing walked.
    const second = engine.layout(doc, opts)
    expect(second.version).toBe(1)
    expect(engine.lastStats.blocksWalked).toBe(0)
    expect(engine.lastStats.blocksSpliced).toBe(0)
    expect(engine.lastStats.linesRebroken).toBe(0)

    // Hash-only edit at 250: same length, same style → same height,
    // different contentHash.
    doc.blocks[250] = para('b250', 'bbbb')
    const third = engine.layout(doc, opts)

    const stats = engine.lastStats
    // FINISH printout: lastStats for the scripted scenario.
    console.log('scripted 300-block lastStats:', stats)
    expect(stats.blocksWalked).toBe(1)
    expect(stats.linesRebroken).toBe(1)
    expect(stats.blocksSpliced).toBe(49) // 251..299, id+hash re-verified
    expect(stats.invalidated).toBe(false)
    expect(stats.cacheEpoch).toBe(0)
    expect(third.version).toBe(2) // work was done → bump

    // PARITY LAW: warm deep-equals cold.
    expect(canonical(third)).toEqual(canonical(cold(doc)))

    // Immutability enforcement: emitted records are frozen.
    expect(Object.isFrozen(third.lines[0])).toBe(true)
    expect(Object.isFrozen(third.lines[0].rect)).toBe(true)
    expect(Object.isFrozen(third.pages[0])).toBe(true)
  })

  it('scripted 300-block: height-growing edit walks to reconvergence, then splices', () => {
    const doc = scriptedDoc()
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    engine.layout(doc, opts)

    // Grow block 250: 17.6px line → 110px line.
    doc.blocks[250] = para('b250', 'aaaa', style100)
    const result = engine.layout(doc, opts)

    const stats = engine.lastStats
    expect(stats.blocksWalked).toBe(31) // 250..280 inclusive
    expect(stats.blocksSpliced).toBe(19) // 281..299 after the snap
    expect(stats.linesRebroken).toBe(1) // only 250; downstream hit lineCache
    expect(canonical(result)).toEqual(canonical(cold(doc)))
  })

  it('insert at 10 reuses the prefix, walks the shifted tail', () => {
    const doc = doc60()
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    engine.layout(doc, opts)

    doc.blocks.splice(10, 0, para('new-block'))
    const result = engine.layout(doc, opts)

    expect(engine.lastStats.blocksWalked).toBe(51) // 10..60
    expect(engine.lastStats.blocksSpliced).toBe(0) // ids shifted: no splice
    expect(engine.lastStats.linesRebroken).toBe(1) // only the new block
    expect(canonical(result)).toEqual(canonical(cold(doc)))
  })

  it('delete at 10 walks the shifted sequence; no misaligned splice', () => {
    const doc = doc60()
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    engine.layout(doc, opts)

    doc.blocks.splice(10, 1)
    const result = engine.layout(doc, opts)

    expect(engine.lastStats.blocksWalked).toBe(49) // 10..58
    expect(engine.lastStats.blocksSpliced).toBe(0)
    expect(engine.lastStats.linesRebroken).toBe(0) // all lineCache hits
    expect(canonical(result)).toEqual(canonical(cold(doc)))
  })

  it('swap-adjacent re-walks both blocks, then splices the aligned tail', () => {
    const doc = doc60()
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    engine.layout(doc, opts)

    const a = doc.blocks[10]
    doc.blocks[10] = doc.blocks[11]
    doc.blocks[11] = a
    const result = engine.layout(doc, opts)

    expect(engine.lastStats.blocksWalked).toBe(2)
    expect(engine.lastStats.blocksSpliced).toBe(48) // 12..59 realigned
    expect(engine.lastStats.linesRebroken).toBe(0) // same hashes → hits
    expect(canonical(result)).toEqual(canonical(cold(doc)))
  })

  it('opts change invalidates wholesale: epoch 0 → 1, full walk, parity', () => {
    const doc = doc60()
    const engine = createLayoutEngine({ metrics: FakeMetrics })

    const first = engine.layout(doc, opts)
    expect(engine.lastStats.cacheEpoch).toBe(0)
    expect(engine.lastStats.invalidated).toBe(false)
    expect(first.version).toBe(1)

    const nextOpts: LayoutOptions = { ...opts, preventWidowsAndOrphans: false }
    const second = engine.layout(doc, nextOpts)

    expect(engine.lastStats.invalidated).toBe(true)
    // cacheEpoch persists across calls but resets to 0 in a fresh
    // engine: 0 → 1 on the first opts change, NOT 2.
    expect(engine.lastStats.cacheEpoch).toBe(1)
    expect(engine.lastStats.blocksWalked).toBe(60)
    expect(engine.lastStats.blocksSpliced).toBe(0)
    expect(second.version).toBe(2)
    expect(canonical(second)).toEqual(canonical(cold(doc, nextOpts)))

    // Same opts again: fully served, version kept, epoch stable.
    const third = engine.layout(doc, nextOpts)
    expect(third.version).toBe(2)
    expect(engine.lastStats.blocksWalked).toBe(0)
    expect(engine.lastStats.cacheEpoch).toBe(1)
  })

  it('duplicate block ids throw loudly (adapter contract)', () => {
    const doc: SemanticDoc = { baseStyle, blocks: [para('dup'), para('dup')] }
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    expect(() => engine.layout(doc, opts)).toThrow(/duplicate block id: dup/)
    expect(() => cold(doc)).toThrow(/duplicate block id/)
  })

  it('M2.5: an edit inside a bonded successor re-walks its predecessor (stats assert)', () => {
    // W (keepNext) is bonded to S: W's cached placement consumed S's
    // first-line height, so an edit inside S invalidates W's cached
    // placement too — the resume point extends BACKWARD through the
    // bond. All 7 lines fit one page, so geometry is unaffected; the
    // test pins the cache mechanics.
    const doc: SemanticDoc = {
      baseStyle,
      blocks: [
        para('f', 'aaaa'),
        para('w', 'aaaa '.repeat(24), style16, { keepNext: true }),
        para('s', 'aaaa '.repeat(24), style16),
        para('t', 'aaaa'),
        para('u', 'aaaa'),
        para('v', 'aaaa'),
      ],
    }
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    engine.layout(doc, opts)

    // Hash-only edit inside the bonded successor S.
    doc.blocks[2] = para('s', 'bbbb '.repeat(24), style16)
    const result = engine.layout(doc, opts)

    const stats = engine.lastStats
    console.log('bonded-edit lastStats:', stats)
    expect(stats.blocksWalked).toBe(2) // W (predecessor re-walk) + S
    expect(stats.linesRebroken).toBe(1) // only S missed lineCache
    expect(stats.blocksSpliced).toBe(3) // T, U, V
    expect(canonical(result)).toEqual(canonical(cold(doc)))
  })

  it('M2.5: splice still fires through unchanged bonded regions', () => {
    const doc: SemanticDoc = {
      baseStyle,
      blocks: [
        para('f', 'aaaa'),
        para('w', 'aaaa '.repeat(24), style16, { keepNext: true }),
        para('s', 'aaaa '.repeat(24), style16),
        para('t', 'aaaa'),
        para('u', 'aaaa'),
        para('v', 'aaaa'),
      ],
    }
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    engine.layout(doc, opts)

    // Hash-only edit of F, BEFORE the bonded pair: the bonded region
    // (W→S) is unchanged and its cached placements consumed consistent
    // heights — the splice consumes it whole.
    doc.blocks[0] = para('f', 'bbbb')
    const result = engine.layout(doc, opts)

    expect(engine.lastStats.blocksWalked).toBe(1)
    expect(engine.lastStats.linesRebroken).toBe(1)
    expect(engine.lastStats.blocksSpliced).toBe(5) // W, S (bonded pair), T, U, V
    expect(canonical(result)).toEqual(canonical(cold(doc)))
  })
})
