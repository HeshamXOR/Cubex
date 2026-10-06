import { describe, expect, it } from 'vitest'
import type { DiagnosticItem, DiagnosticsSummary } from '../../../shared/ipc'
import { countProblems, describeProblems, diagnosticsForFile, isCheckedPath } from './problemCounts'

const problem = (over: Partial<DiagnosticItem> = {}): DiagnosticItem => ({ path: 'src/a.ts', line: 1, col: 1, code: 'TS2322', message: 'boom', ...over })

describe('isCheckedPath', () => {
  it('accepts the files the compiler reads and nothing else', () => {
    for (const yes of ['a.ts', 'src/a.tsx', 'a.js', 'a.jsx', 'a.mts', 'a.cts', 'a.mjs', 'a.cjs', 'SRC/A.TS']) expect(isCheckedPath(yes), yes).toBe(true)
    for (const no of ['a.md', 'a.json', 'a.css', 'a.d.ts.map', 'ts', 'a.tsx.bak', 'a.py']) expect(isCheckedPath(no), no).toBe(false)
  })
})

describe('counting', () => {
  it('splits problems into errors and warnings, an item without a severity being an error', () => {
    expect(countProblems([problem(), problem({ severity: 'error' }), problem({ severity: 'warning' })])).toEqual({ errors: 2, warnings: 1 })
    expect(countProblems([])).toEqual({ errors: 0, warnings: 0 })
  })

  it('words the counts the way the chip shows them', () => {
    expect(describeProblems({ errors: 1, warnings: 0 })).toBe('1 error')
    expect(describeProblems({ errors: 2, warnings: 0 })).toBe('2 errors')
    expect(describeProblems({ errors: 0, warnings: 1 })).toBe('1 warning')
    expect(describeProblems({ errors: 0, warnings: 3 })).toBe('3 warnings')
    expect(describeProblems({ errors: 2, warnings: 1 })).toBe('2 errors, 1 warning')
    expect(describeProblems({ errors: 0, warnings: 0 })).toBe('')
  })
})

describe('diagnosticsForFile', () => {
  const items = [problem({ path: 'src/a.ts' }), problem({ path: 'src/b.ts', line: 4 }), problem({ path: 'src/b.ts', line: 9 })]

  it('gives a one-file edit its whole summary', () => {
    const summary: DiagnosticsSummary = { errors: 3, warnings: 0, items }
    expect(diagnosticsForFile(summary, 'src/a.ts', false)).toBe(summary)
    expect(diagnosticsForFile(undefined, 'src/a.ts', false)).toBeUndefined()
  })

  it('uses the per-file counts of a patch, with that file problems', () => {
    const summary: DiagnosticsSummary = { errors: 5, warnings: 1, items, files: [{ path: 'src/a.ts', errors: 1, warnings: 1 }, { path: 'src/b.ts', errors: 4, warnings: 0 }] }
    expect(diagnosticsForFile(summary, 'src/b.ts', true)).toEqual({ errors: 4, warnings: 0, items: [items[1], items[2]] })
    expect(diagnosticsForFile(summary, 'src/a.ts', true)).toEqual({ errors: 1, warnings: 1, items: [items[0]] })
    expect(diagnosticsForFile(summary, 'src/c.ts', true)).toBeUndefined()
  })

  it('falls back to the problems listed for the path when a patch has no per-file counts', () => {
    const summary: DiagnosticsSummary = { errors: 3, warnings: 0, items }
    expect(diagnosticsForFile(summary, 'src/b.ts', true)).toEqual({ errors: 2, warnings: 0, items: [items[1], items[2]] })
    expect(diagnosticsForFile({ errors: 1, warnings: 0 }, 'src/b.ts', true)).toBeUndefined()
  })
})
