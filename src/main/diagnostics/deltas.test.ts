import { describe, expect, it } from 'vitest'
import { buildReport, diagnosticKey, formatDiagnosticLine, newDiagnostics } from './deltas'
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

  it('keys on code and message, not on position or whitespace', () => {
    expect(diagnosticKey(diag({ line: 1, col: 1 }))).toBe(diagnosticKey(diag({ line: 99, col: 40 })))
    expect(diagnosticKey(diag({ message: 'a  b\n   c' }))).toBe(diagnosticKey(diag({ message: 'a b c' })))
    expect(diagnosticKey(diag({ code: 'TS1' }))).not.toBe(diagnosticKey(diag({ code: 'TS2' })))
    expect(diagnosticKey(diag({ message: 'one' }))).not.toBe(diagnosticKey(diag({ message: 'two' })))
  })

  it('counts duplicates: a second identical error is new, and the one on unchanged code is the old one', () => {
    const old = diag({ line: 9, context: 'const a: number = "x"' })
    const added = diag({ line: 3, context: 'const b: number = "y"' })
    expect(newDiagnostics([old], [added, { ...old, line: 11 }])).toEqual([added])
  })

  it('does not call an error new because the line it is on was edited, when the count is unchanged', () => {
    const before = [diag({ line: 4, context: 'const a: number = "x"' })]
    const after = [diag({ line: 4, context: 'const a: number = "y"' })]
    expect(newDiagnostics(before, after)).toEqual([])
  })

  it('treats everything as new when there is no baseline', () => {
    expect(newDiagnostics([], [diag(), diag({ code: 'TS2304', message: 'x' })])).toHaveLength(2)
  })
})

describe('formatDiagnosticLine', () => {
  it('uses path:line:col severity code: message', () => {
    expect(formatDiagnosticLine(diag())).toBe("src/a.ts:12:5 error TS2322: Type 'string' is not assignable to type 'number'.")
  })

  it('omits the code when there is none', () => {
    expect(formatDiagnosticLine(diag({ code: undefined }))).toBe("src/a.ts:12:5 error: Type 'string' is not assignable to type 'number'.")
  })

  it('keeps a long chained message on one line and shortens it', () => {
    const message = `Type 'A' is not assignable to type 'B'.\n  Types of property 'x' are incompatible.\n    ${'y '.repeat(400)}`
    const line = formatDiagnosticLine(diag({ message }))
    expect(line).not.toMatch(/[\r\n]/)
    expect(line.length).toBeLessThanOrEqual(420)
    expect(line.endsWith('...')).toBe(true)
    expect(line).toContain("Types of property 'x' are incompatible.")
  })

  it('removes control characters from messages', () => {
    expect(formatDiagnosticLine(diag({ message: 'bad\u0000\u001b[31m text' }))).not.toMatch(/[\u0000-\u001f]/)
  })
})

describe('buildReport', () => {
  it('is undefined when nothing is new, so silence is never turned into a clean bill of health', () => {
    expect(buildReport([[]])).toBeUndefined()
    expect(buildReport([])).toBeUndefined()
  })

  it('formats the appended block exactly', () => {
    const report = buildReport([[diag(), diag({ line: 15, col: 1, code: 'TS2304', message: "Cannot find name 'q'." })]])!
    expect(report.text).toBe(
      "\n\nNew diagnostics (2 errors):\nsrc/a.ts:12:5 error TS2322: Type 'string' is not assignable to type 'number'.\n" +
      "src/a.ts:15:1 error TS2304: Cannot find name 'q'."
    )
    expect(report.summary).toEqual({
      errors: 2, warnings: 0,
      items: [
        { path: 'src/a.ts', line: 12, col: 5, code: 'TS2322', message: "Type 'string' is not assignable to type 'number'." },
        { path: 'src/a.ts', line: 15, col: 1, code: 'TS2304', message: "Cannot find name 'q'." }
      ]
    })
  })

  it('says "1 error" in the singular', () => {
    expect(buildReport([[diag()]])!.text).toMatch(/^\n\nNew diagnostics \(1 error\):\n/)
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

  it('counts warnings but never prints them', () => {
    const report = buildReport([[diag({ severity: 'warning', code: 'TS6385', message: 'deprecated' }), diag()]])!
    expect(report.summary).toMatchObject({ errors: 1, warnings: 1 })
    expect(report.text).not.toContain('deprecated')
  })

  it('reports warnings alone as a summary with no text', () => {
    const report = buildReport([[diag({ severity: 'warning' })]])!
    expect(report.text).toBe('')
    expect(report.summary).toEqual({ errors: 0, warnings: 1, items: [] })
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

  it('tells the window which file each problem of a multi-file edit belongs to', () => {
    const a = [diag({ path: 'src/a.ts' }), diag({ path: 'src/a.ts', line: 20, severity: 'warning', code: 'TS6133' })]
    const c = [diag({ path: 'src/c.ts' }), diag({ path: 'src/c.ts', line: 3 })]
    const report = buildReport([a, [], c])!
    expect(report.summary.files).toEqual([{ path: 'src/a.ts', errors: 1, warnings: 1 }, { path: 'src/c.ts', errors: 2, warnings: 0 }])
    expect(report.summary).toMatchObject({ errors: 3, warnings: 1 })
  })

  it('leaves per-file counts out when the edit changed one file', () => {
    expect(buildReport([[diag(), diag({ line: 20 })]])!.summary).not.toHaveProperty('files')
  })
})
