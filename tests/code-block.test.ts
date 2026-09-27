import { describe, expect, it } from 'vitest'
import { createLayoutEngine } from '../src/index.js'
import { FakeMetrics } from './fake-metrics.js'
import type { LayoutOptions, LineBox, Run, SemanticDoc, TextStyle } from '../src/index.js'

// CODE BLOCK (codeBlock): fragmentable monospace block kind —
// source-line semantics (see breakCodeLines for the v1 rulings).
// PAGELESS-MATCHED STYLE (receipt): the pageless editor renders
// TipTap's CodeBlock as <pre><code> with no font of its own — UA
// `pre { font-family: monospace }` + the container's inherited
// document-default size (16px in the shell config). Runs here carry
// exactly that: monospace @ 16.
// FakeMetrics: 10px/char; ascent 0.85×fs + descent 0.25×fs = 17.6px
// lines at fs 16. Letter, 96 margins → contentBox 624×864 →
// 62 chars/line (620 ≤ 624), 49 lines/page (862.4 ≤ 864).
const mono: TextStyle = { fontFamily: 'monospace', fontSize: 16 }
const baseStyle: TextStyle = { fontFamily: 'system-ui', fontSize: 16 }
const opts: LayoutOptions = {
  page: { width: 816, height: 1056 },
  margins: { top: 96, right: 96, bottom: 96, left: 96 },
}

const run = (text: string): Run => ({ text, style: mono })

function code(id: string, text: string) {
  return { id, kind: 'codeBlock' as const, runs: [run(text)] }
}

// Filler paragraph: fontSize 100 → 110px lines.
const filler = (id: string, lines: number, spaceAfter = 0) => ({
  id,
  kind: 'paragraph' as const,
  runs: [{ text: 'aaaa '.repeat(12 * lines), style: { fontFamily: 'sans-serif', fontSize: 100 } }],
  ...(spaceAfter ? { spaceAfter } : {}),
})

const layout = (doc: SemanticDoc, o: LayoutOptions = opts) =>
  createLayoutEngine({ metrics: FakeMetrics }).layout(doc, o)

const byBlock = (result: { lines: LineBox[] }, id: string) =>
  result.lines.filter((l) => l.blockId === id)

describe('codeBlock: fragmentable monospace block kind', () => {
  it('1. source lines yield LineBoxes 1:1 minimum; newlines are honored and excluded from ranges', () => {
    const result = layout({
      baseStyle,
      blocks: [code('c', 'let a = 1\nlet b = 2\nreturn a + b')],
    })
    const c = byBlock(result, 'c')
    expect(c).toHaveLength(3)
    // '\n' belongs to no range: line 0 ends at 9, line 1 starts at 10.
    expect(c.map((l) => [l.lineIndex, l.rangeStart, l.rangeEnd])).toEqual([
      [0, 0, 9],
      [1, 10, 19],
      [2, 20, 32],
    ])
    expect(c.map((l) => l.rect.width)).toEqual([90, 90, 120])
    expect(c.map((l) => l.rect.y)).toEqual([0, 17.6, 35.2])
    expect(c.every((l) => l.rect.x === 0 && l.rect.height === 17.6)).toBe(true)
  })

  it('2. soft wrap is greedy character wrap at the content edge — no char dropped', () => {
    // One 100-char source line: 62 chars fit (620 ≤ 624) → 62+38,
    // ranges contiguous, break mid-"word" by character, not at spaces.
    const result = layout({ baseStyle, blocks: [code('c', 'x'.repeat(100))] })
    const c = byBlock(result, 'c')
    expect(c).toHaveLength(2)
    expect(c.map((l) => [l.rangeStart, l.rangeEnd, l.rect.width])).toEqual([
      [0, 62, 620],
      [62, 100, 380],
    ])
  })

  it('3. leading whitespace preserved exactly; internal spaces never collapse', () => {
    // 4 leading spaces + "return x;" = 13 chars → 130px, range
    // starting at 0 (never trimmed); "  }" keeps its 2-space indent.
    const result = layout({ baseStyle, blocks: [code('c', '    return x;\n  }')] })
    const c = byBlock(result, 'c')
    expect(c.map((l) => [l.rangeStart, l.rangeEnd, l.rect.width])).toEqual([
      [0, 13, 130],
      [14, 17, 30],
    ])
    // Internal double space is measured as-is: "a  b" = 4 chars = 40px.
    const spaced = layout({ baseStyle, blocks: [code('s', 'a  b')] })
    expect(byBlock(spaced, 's')[0].rect.width).toBe(40)
  })

  it('4. page-crossing split keeps the fragment geometry on the next page', () => {
    // Filler(7) + spaceAfter 30 ends at y 800 → 64px budget → 3 code
    // lines fit (52.8 ≤ 64). Natural 3+3 split; the continuation
    // starts at a bare page top with the same x/width/height.
    const result = layout({
      baseStyle,
      blocks: [filler('fill', 7, 30), code('c', 'L01\nL02\nL03\nL04\nL05\nL06')],
    })
    const c = byBlock(result, 'c')
    expect(result.breaks).toEqual([{ blockId: 'c', atLine: 3, pageIndex: 1 }])
    expect(c.map((l) => [l.pageIndex, l.lineIndex, l.rect.x, l.rect.y, l.rect.width])).toEqual([
      [0, 0, 0, 800, 30],
      [0, 1, 0, 817.6, 30],
      [0, 2, 0, 835.2, 30],
      [1, 3, 0, 0, 30],
      [1, 4, 0, 17.6, 30],
      [1, 5, 0, 35.2, 30],
    ])
  })

  it('5. a code block taller than a page fragments naturally (R4 exemption family)', () => {
    // 60 source lines × 17.6 = 1056 > 864; cap 49 → natural 49+11
    // (n−fits = 11 ≠ 1, so no widow trim; fits ≠ 1, no orphan move).
    const result = layout({
      baseStyle,
      blocks: [code('tall', Array.from({ length: 60 }, (_, i) => `L${i}`).join('\n'))],
    })
    const tall = byBlock(result, 'tall')
    expect(tall).toHaveLength(60)
    expect(result.breaks).toEqual([{ blockId: 'tall', atLine: 49, pageIndex: 1 }])
    expect(tall.filter((l) => l.pageIndex === 0)).toHaveLength(49)
    expect(tall[48].rect.y).toBeCloseTo(48 * 17.6, 9)
    expect(tall[49].rect.y).toBe(0) // continuation at a bare page top
    expect(tall.slice(49).every((l) => l.rect.x === 0 && l.rect.height === 17.6)).toBe(true)
    expect(tall[59].lineIndex).toBe(59) // lineIndex continuous across pages
  })

  it('6. orphan/widow rules apply like a paragraph: a 2-line block moves whole', () => {
    // Filler(7) ends at 770 → 94px budget → 5 of 6 lines fit; the
    // widow rule (R3) backs the split to 4+2 instead of 5+1.
    const natural = layout({
      baseStyle,
      blocks: [filler('f1', 7), code('c', 'L1\nL2\nL3\nL4\nL5\nL6', )],
    })
    expect(natural.breaks).toEqual([{ blockId: 'c', atLine: 4, pageIndex: 1 }])

    // 1-line budget + 2-line block → R2 orphan moves the whole block.
    // Filler(7)+70 ends at 840 → 24px budget → fits == 1.
    const orphan = layout({
      baseStyle,
      blocks: [filler('f2', 7, 70), code('d', 'A\nB')],
    })
    expect(orphan.breaks).toEqual([])
    expect(byBlock(orphan, 'd').every((l) => l.pageIndex === 1)).toBe(true)
  })

  it('7. an empty source line yields a full-height empty LineBox under the code font', () => {
    // "a\n\nb": the blank middle line is width 0 but exactly as tall
    // as its siblings (measured under the first run's style, not
    // baseStyle). A trailing '\n' opens one final blank line, like a
    // <pre> shows.
    const result = layout({ baseStyle, blocks: [code('c', 'a\n\nb\nd\n')] })
    const c = byBlock(result, 'c')
    expect(c).toHaveLength(5)
    expect(c.map((l) => [l.rangeStart, l.rangeEnd, l.rect.width, l.rect.height])).toEqual([
      [0, 1, 10, 17.6],
      [2, 2, 0, 17.6], // blank line, code-font height
      [3, 4, 10, 17.6],
      [5, 6, 10, 17.6],
      [7, 7, 0, 17.6], // trailing newline's blank line
    ])
  })

  it('8. caching/hash rules unchanged: warm re-layout serves the cache; kind routes the breaker', () => {
    const engine = createLayoutEngine({ metrics: FakeMetrics })
    const doc: SemanticDoc = { baseStyle, blocks: [code('c', 'a b\nc')] }

    const first = engine.layout(doc, opts)
    const second = engine.layout(doc, opts)
    expect(second.lines).toEqual(first.lines) // warm == cold (parity)
    expect(engine.lastStats.linesRebroken).toBe(0) // lineCache hit

    // Same id, same runs, DIFFERENT kind: prose breaks "a b\nc" as one
    // 5-char line; code honors the newline as two. Kind is hashed, so
    // the warm engine must re-break.
    const proseDoc: SemanticDoc = {
      baseStyle,
      blocks: [{ id: 'c', kind: 'paragraph', runs: [run('a b\nc')] }],
    }
    const prose = engine.layout(proseDoc, opts)
    expect(prose.lines.map((l) => [l.rangeStart, l.rangeEnd, l.rect.width])).toEqual([
      [0, 5, 50],
    ])
    expect(engine.lastStats.linesRebroken).toBe(1)
  })
})
