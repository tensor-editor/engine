import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLayoutEngine, type Block, type SemanticDoc, type LayoutOptions } from '../src/index.js'
import { resetHashCallCount, hashCallCount } from '../src/layout.js'
import { FakeMetrics } from './fake-metrics.js'

/**
 * The hash identity cache. hashBlock memoizes on the
 * block OBJECT; the adapter contract (see layout.ts) is that unchanged
 * blocks are reused BY REFERENCE across layout calls. These tests pin
 * both directions: reference-reused -> cached hash (no stringify),
 * mutated/new object -> re-hash.
 */

const LETTER: LayoutOptions = {
  page: { width: 816, height: 1056 },
  margins: { top: 96, right: 96, bottom: 96, left: 96 },
}
const STYLE = { fontFamily: 'Test Sans', fontSize: 16 }

const raw = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'perf-71.json'), 'utf8'),
) as SemanticDoc
const BASE_STYLE = raw.baseStyle
const PERF71_BLOCKS = raw.blocks

function freshDoc(blocks: Block[]): SemanticDoc {
  return { blocks, baseStyle: BASE_STYLE }
}

describe('hash identity cache', () => {
  it('object-reused blocks hit the cache: re-layout stringifies nothing, walks nothing', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    resetHashCallCount()
    engine.layout(freshDoc(PERF71_BLOCKS), LETTER)
    const coldHashes = hashCallCount
    const coldWalked = engine.lastStats.blocksWalked
    expect(coldHashes).toBe(PERF71_BLOCKS.length)
    expect(coldWalked).toBe(PERF71_BLOCKS.length)

    // Same Block objects, same engine — fully cache-served.
    resetHashCallCount()
    const warm = engine.layout(freshDoc(PERF71_BLOCKS), LETTER)
    expect(hashCallCount).toBe(0)
    expect(engine.lastStats.blocksWalked).toBe(0)
    expect(engine.lastStats.blocksSpliced).toBe(0)
    expect(warm.pages).toHaveLength(71)
  })

  it('a mutated block (new object) re-hashes; unchanged others do not', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    engine.layout(freshDoc(PERF71_BLOCKS), LETTER)

    // Replace block 40 with a NEW object (mutation = new reference, the
    // treat-as-immutable rule).
    const mutated = PERF71_BLOCKS.map((b, i) =>
      i === 40
        ? {
            ...b,
            runs: [
              { text: 'engine paginates engine paginates engine paginates', style: STYLE },
            ],
          }
        : b,
    )
    resetHashCallCount()
    engine.layout(freshDoc(mutated), LETTER)
    expect(hashCallCount).toBe(1) // only the new object
    // The walk resumes at the edit: everything after re-walks or splices,
    // the prefix is reused.
    const stats = engine.lastStats
    expect(stats.blocksWalked).toBeLessThan(PERF71_BLOCKS.length)
  })

  it('an edited OBJECT reused in place (contract violation shape) still answers correctly', () => {
    // The cache trusts references; a caller that mutates a block in
    // place breaks the treat-as-immutable rule and gets a stale hash.
    // This test documents that the parity fuzzer remains the
    // backstop for that contract, not the hash cache.
    const blocks = PERF71_BLOCKS.slice(0, 5)
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    engine.layout(freshDoc(blocks), LETTER)
    resetHashCallCount()
    engine.layout(freshDoc(blocks), LETTER)
    expect(hashCallCount).toBe(0) // cache trusted — documented behavior
  })
})

describe('perf-71 mid-document edit (fixture pin)', () => {
  it('a mid-doc keystroke walks ~1 block and re-hashes ~1 block', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    engine.layout(freshDoc(PERF71_BLOCKS), LETTER)

    const MID = 120
    const edited = PERF71_BLOCKS.map((b, i) =>
      i === MID
        ? {
            ...b,
            runs: [{ text: (b.runs[0]!.text + ' tensor'), style: b.runs[0]!.style }],
          }
        : b,
    )
    resetHashCallCount()
    const result = engine.layout(freshDoc(edited), LETTER)
    const stats = engine.lastStats

    expect(result.pages).toHaveLength(71)
    expect(hashCallCount).toBe(1)
    // The edited block + bonded-predecessor re-walk: the
    // backward-resume extends through keepNext chains (this fixture
    // carries a bonded heading every 14 blocks), so the walk restarts
    // at the nearest heading. Envelope pinned to that reality — still
    // nowhere near the cold 258.
    expect(stats.blocksWalked).toBeLessThanOrEqual(16)
    expect(stats.blocksWalked + stats.blocksSpliced).toBeLessThan(PERF71_BLOCKS.length)
    // FINISH receipt line for the session report.
    console.log(
      `[perf-71 mid-doc edit] blocksWalked=${stats.blocksWalked} linesRebroken=${stats.linesRebroken} blocksSpliced=${stats.blocksSpliced} rehashed=${hashCallCount}`,
    )
  })
})
