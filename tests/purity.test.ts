import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

function tsFilesUnder(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...tsFilesUnder(full))
    else if (entry.name.endsWith('.ts')) files.push(full)
  }
  return files
}

// Naive comment stripping — block comments first, then line comments — so
// prose mentioning window./document./react doesn't trip the check.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '')
}

const REACT_IMPORT =
  /(?:import|from|require\s*\()\s*[^;'"`\n]*['"]react(?:-dom)?(?:\/[^'"]*)?['"]/

describe('src/ purity', () => {
  it('never references document./window. nor imports react', () => {
    const violations: string[] = []
    for (const file of tsFilesUnder(srcDir)) {
      const code = stripComments(readFileSync(file, 'utf8'))
      if (code.includes('document.') || code.includes('window.')) {
        violations.push(`${file}: references document. or window.`)
      }
      if (REACT_IMPORT.test(code)) {
        violations.push(`${file}: imports react or react-dom`)
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })
})
