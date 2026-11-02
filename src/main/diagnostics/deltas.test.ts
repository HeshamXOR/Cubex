import { describe, expect, it } from 'vitest'
import { buildReport, newDiagnostics } from './deltas'
import type { Diagnostic } from './types'

function diag(over: Partial<Diagnostic> = {}): Diagnostic {
  return {
    path: 'src/a.ts', line: 12, col: 5, severity: 'error', code: 'TS2322',
    message: "Type 'string' is not assignable to type 'number'.", ...over
  }
}

describe('newDiagnostics', () => {
  it('ignores an existing error whose line moved', () => {
    const before = [diag({ line: 10 })]
    const after = [diag({ line: 14 })]
    expect(newDiagnostics(before, after)).toEqual([])
  })

  it('reports an error that was not there before and drops resolved ones', () => {
    const resolved = diag({ code: 'TS2304', message: "Cannot find name 'x'.", line: 3 })
    const fresh = diag({ code: 'TS2551', message: "Property 'nme' does not exist on type 'User'.", line: 20 })
    expect(newDiagnostics([resolved, diag()], [diag(), fresh])).toEqual([fresh])
  })

  it('counts duplicates: a second identical error is new, and the one on unchanged code is the old one', () => {
    const old = diag({ line: 9, context: 'const a: number = "x"' })
    const added = diag({ line: 3, context: 'const b: number = "y"' })
    expect(newDiagnostics([old], [added, { ...old, line: 11 }])).toEqual([added])
  })
})

describe('buildReport', () => {
  it('is undefined when nothing is new, so silence is never turned into a clean bill of health', () => {
    expect(buildReport([[]])).toBeUndefined()
    expect(buildReport([])).toBeUndefined()
  })

  it('lists at most five errors per file, orders them by position and says how many were left out', () => {
    const many = Array.from({ length: 8 }, (_, i) => diag({ line: 40 - i, message: `problem ${i}` }))
    const report = buildReport([many])!
    const lines = report.text.split('\n')
    expect(lines[2]).toBe('New diagnostics (8 errors):')
    expect(lines.filter((line) => line.startsWith('src/a.ts:'))).toHaveLength(5)
    expect(report.summary.items.map((item) => item.line)).toEqual([33, 34, 35, 36, 37])
    expect(report.text).toMatch(/\.\.\. and 3 more errors not shown\.$/)
    expect(report.summary.errors).toBe(8)
  })

  it('keeps per-file caps and an overall cap across a patch, in file order', () => {
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'].map((path) =>
      Array.from({ length: 6 }, (_, i) => diag({ path, line: i + 1, message: `${path} ${i}` })))
    const report = buildReport(files)!
    const shown = report.text.split('\n').filter((line) => /^src\//.test(line))
    expect(shown).toHaveLength(15)
    expect(shown[0]).toContain('src/a.ts:1:5')
    expect(shown[5]).toContain('src/b.ts:1:5')
    expect(report.text).toContain('New diagnostics (24 errors):')
    expect(report.text).toMatch(/\.\.\. and 9 more errors not shown\.$/)
    expect(report.summary.items).toHaveLength(15)
  })
})
