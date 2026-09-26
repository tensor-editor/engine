/**
 * Generator for tests/perf-71.json — the canonical 71-page stress doc.
 * Deterministic: a seeded LCG drives block choice/length/flow,
 * and the REAL engine (FakeMetrics) measures the page count as blocks
 * are appended until exactly 71 pages. Regenerating produces a
 * byte-identical fixture; regenerate intentionally, never casually.
 *
 * Run from the word-processor checkout (it has tsx):
 *   npx -y tsx tests/gen-perf71.ts
 * (paths resolve against this file's location either way)
 */
import { createLayoutEngine, type Block, type SemanticDoc, type LayoutOptions } from '../src/index.js'
import { FakeMetrics } from './fake-metrics.js'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LETTER: LayoutOptions = {
  page: { width: 816, height: 1056 },
  margins: { top: 96, right: 96, bottom: 96, left: 96 },
}

// Seeded LCG — deterministic across runs and Node versions.
let state = 0x5eed71
function rnd(): number {
  state = (state * 1664525 + 1013904223) % 4294967296
  return state / 4294967296
}
function rint(lo: number, hi: number): number {
  return lo + Math.floor(rnd() * (hi - lo + 1))
}

const WORDS = [
  'tensor', 'engine', 'layout', 'paginates', 'blocks', 'lines', 'pages', 'measurement',
  'parity', 'widow', 'orphan', 'fragment', 'splice', 'walk', 'cache', 'metrics',
  'ink', 'sheet', 'margin', 'content', 'flow', 'bond', 'break', 'resume',
]

function words(count: number): string {
  const out: string[] = []
  for (let i = 0; i < count; i++) out.push(WORDS[rint(0, WORDS.length - 1)])
  return out.join(' ')
}

const STYLE = { fontFamily: 'Test Sans', fontSize: 16 }
const BOLD = { ...STYLE, bold: true }

function nextBlock(i: number): Block {
  if (i % 14 === 0) {
    const level = (i % 42 === 0 ? 1 : i % 21 === 0 ? 2 : 3)
    return {
      id: `h${i}`,
      kind: 'heading',
      level,
      runs: [{ text: words(rint(2, 5)), style: BOLD }],
      // keepNext: a heading bonds to its first following paragraph.
      flow: { keepNext: true },
    }
  }
  if (i % 9 === 0) {
    return {
      id: `p${i}`,
      kind: 'paragraph',
      runs: [{ text: words(rint(20, 90)), style: STYLE }],
      flow: { breakBefore: 'page' },
    }
  }
  const flow =
    i % 5 === 0
      ? { widowControl: false }
      : i % 7 === 0
        ? { keepLines: true }
        : undefined
  return {
    id: `p${i}`,
    kind: 'paragraph',
    runs: [{ text: words(rint(10, 240)), style: STYLE }],
    ...(flow && { flow }),
  }
}

const blocks: Block[] = []
let i = 0
// Main fill: append until page 70 is reached, then single-line
// paragraphs walk it to exactly 71 (never overshoot: 1 line = +1 page
// max, and a fresh page always places it).
for (;;) {
  const block = nextBlock(i++)
  blocks.push(block)
  const engine = createLayoutEngine({ metrics: FakeMetrics })
  const result = engine.layout({ blocks, baseStyle: STYLE }, LETTER)
  if (result.pages.length >= 70) break
}
for (; ; ) {
  blocks.push({ id: `tail${i}`, kind: 'paragraph', runs: [{ text: 'x', style: STYLE }] })
  const engine = createLayoutEngine({ metrics: FakeMetrics })
  const result = engine.layout({ blocks, baseStyle: STYLE }, LETTER)
  if (result.pages.length === 71) break
  i++
}

const doc: SemanticDoc = { blocks, baseStyle: STYLE }
const verify = createLayoutEngine({ metrics: FakeMetrics }).layout(doc, LETTER)
if (verify.pages.length !== 71) throw new Error(`expected 71 pages, got ${verify.pages.length}`)

const here = dirname(fileURLToPath(import.meta.url))
writeFileSync(
  join(here, 'perf-71.json'),
  JSON.stringify(doc, null, 1) + '\n',
)

// App-side shadow copy (same content as loadable HTML) — the converter
// lives in the shell repo's test fixtures; write both from one seed.
const html = blocks
  .map((b) =>
    b.kind === 'heading'
      ? `<h${b.level}>${b.runs[0]!.text}</h${b.level}>`
      : `<p>${b.runs[0]!.text}</p>`,
  )
  .join('\n')
writeFileSync(
  '/home/tristin/Projects/word-processor/src/tests/fixtures/perf-71.html',
  html + '\n',
)

console.log(
  `perf-71: ${blocks.length} blocks, ${verify.lines.length} lines, ${verify.pages.length} pages`,
)
