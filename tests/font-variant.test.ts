import { describe, expect, it } from 'vitest'
import { createLayoutEngine, type Block, type LayoutOptions, type SemanticDoc, type TextStyle } from '../src/index.js'
import { FakeMetrics } from './fake-metrics.js'

/**
 * TextStyle.fontVariant (M-STYLES). The engine never interprets the
 * field, but it MUST participate in contentHash: a variant edit is a
 * definition edit flowing through the registry-epoch path, and if the
 * hash ignored it the walk cache would serve stale lines. The
 * discriminator is the walk machine's own resume: an edit whose
 * contentHash equals the cached one NEVER re-walks; a fontVariant-only
 * edit MUST. FakeMetrics ignores fontVariant by design (width = f(text)
 * only), so the two edits are geometrically identical — only the hash
 * can tell them apart, which is exactly what these tests pin.
 */

const LETTER: LayoutOptions = {
  page: { width: 816, height: 1056 },
  margins: { top: 96, right: 96, bottom: 96, left: 96 },
}
const BASE: TextStyle = { fontFamily: 'Test Sans', fontSize: 16 }

function para(id: string, text: string, style: TextStyle = BASE): Block {
  return { id, kind: 'paragraph', runs: [{ text, style }] }
}

function fourBlockDoc(): SemanticDoc {
  return { blocks: ['b0', 'b1', 'b2', 'b3'].map((id) => para(id, 'same text')), baseStyle: BASE }
}

describe('TextStyle.fontVariant participates in contentHash', () => {
  it('control: a new-object, identical-content replacement never re-walks', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    engine.layout(fourBlockDoc(), LETTER)
    // New object for b1, bit-for-bit identical content: the hash
    // recomputes on the new reference but comes out EQUAL, so the
    // resume finds no differing index and nothing re-breaks.
    const doc = fourBlockDoc()
    doc.blocks[1] = para('b1', 'same text')
    const result = engine.layout(doc, LETTER)
    const stats = engine.lastStats
    expect(stats.blocksWalked).toBe(0)
    expect(stats.linesRebroken).toBe(0)
    expect(result.lines).toHaveLength(4)
  })

  it('control: a text edit re-walks (the resume machinery is live)', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    engine.layout(fourBlockDoc(), LETTER)
    const doc = fourBlockDoc()
    doc.blocks[1] = para('b1', 'other text')
    engine.layout(doc, LETTER)
    expect(engine.lastStats.blocksWalked).toBe(1)
    expect(engine.lastStats.linesRebroken).toBe(1)
  })

  it('a fontVariant-ONLY edit re-walks: contentHash of the run differs', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    engine.layout(fourBlockDoc(), LETTER)
    // Same text, same shape — ONLY fontVariant added. If the hash
    // ignored it this would behave like the identical-content control
    // (0 walked); it must behave like the text edit instead.
    const doc = fourBlockDoc()
    doc.blocks[1] = para('b1', 'same text', { ...BASE, fontVariant: 'small-caps' })
    const result = engine.layout(doc, LETTER)
    expect(engine.lastStats.blocksWalked).toBe(1)
    expect(engine.lastStats.linesRebroken).toBe(1)
    expect(result.lines).toHaveLength(4)
  })

  it("explicit 'normal' differs from absent (adapters must strip the no-op)", () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    engine.layout(fourBlockDoc(), LETTER)
    // stableStringify drops undefined-valued keys but keeps PRESENT
    // values, so {fontVariant: 'normal'} ≠ absent. The seam ruling:
    // the shell normalizes (absent ≡ 'normal') before runs reach the
    // engine, mirroring lineHeight's absent ≡ 1.0 invariant — pinned
    // here so the shell side knows the hash treats them as distinct.
    const doc = fourBlockDoc()
    doc.blocks[1] = para('b1', 'same text', { ...BASE, fontVariant: 'normal' })
    engine.layout(doc, LETTER)
    expect(engine.lastStats.blocksWalked).toBe(1)
  })
})
