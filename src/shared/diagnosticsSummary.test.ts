import { describe, expect, it } from 'vitest'
import { MAX_SUMMARY_FILES, MAX_SUMMARY_ITEMS, sanitizeDiagnosticItem, sanitizeDiagnosticsSummary } from './diagnosticsSummary'

const item = { path: 'src/a.ts', line: 12, col: 5, code: 'TS2322', message: "Type 'string' is not assignable to type 'number'." }

describe('sanitizeDiagnosticItem', () => {
  it('keeps a well-formed problem as it is', () => {
    expect(sanitizeDiagnosticItem(item)).toEqual(item)
    expect(sanitizeDiagnosticItem({ ...item, severity: 'warning' })).toEqual({ ...item, severity: 'warning' })
  })

  it('treats an unknown severity as an error and drops a malformed code', () => {
    expect(sanitizeDiagnosticItem({ ...item, severity: 'catastrophe', code: 'TS 2322 <b>' })).toEqual({ path: 'src/a.ts', line: 12, col: 5, message: item.message })
  })

  it('refuses a problem it cannot place or describe', () => {
    for (const bad of [null, 'text', [], {}, { ...item, path: '' }, { ...item, path: 'a\0b.ts' }, { ...item, line: 0 }, { ...item, col: 1.5 }, { ...item, line: '3' }, { ...item, message: '   ' }, { ...item, message: 4 }]) {
      expect(sanitizeDiagnosticItem(bad)).toBeUndefined()
    }
  })

  it('collapses control characters and bounds the message', () => {
    const cleaned = sanitizeDiagnosticItem({ ...item, message: `first\nsecond\u0007\t${'x'.repeat(600)}` })
    expect(cleaned?.message).toMatch(/^first second x+\.\.\.$/)
    expect(cleaned!.message.length).toBe(300)
  })
})

describe('sanitizeDiagnosticsSummary', () => {
  it('keeps counts and the problems that survive validation', () => {
    expect(sanitizeDiagnosticsSummary({ errors: 2, warnings: 1, items: [item, { nonsense: true }] })).toEqual({ errors: 2, warnings: 1, items: [item] })
  })

  it('omits items when none are usable', () => {
    expect(sanitizeDiagnosticsSummary({ errors: 1, warnings: 0, items: [] })).toEqual({ errors: 1, warnings: 0 })
    expect(sanitizeDiagnosticsSummary({ errors: 1, warnings: 0 })).toEqual({ errors: 1, warnings: 0 })
  })

  it('drops a summary with nothing to show, because an absent value already means nothing new', () => {
    expect(sanitizeDiagnosticsSummary({ errors: 0, warnings: 0, items: [item] })).toBeUndefined()
  })

  it('rejects counts that are not whole non-negative numbers', () => {
    for (const bad of [undefined, null, 'x', { errors: -1, warnings: 0 }, { errors: 1.5, warnings: 0 }, { errors: '2', warnings: 0 }, { errors: 1 }, { errors: Infinity, warnings: 0 }, { errors: 2_000_000, warnings: 0 }]) {
      expect(sanitizeDiagnosticsSummary(bad)).toBeUndefined()
    }
  })

  it('keeps at most the first 15 problems', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({ ...item, line: index + 1 }))
    const summary = sanitizeDiagnosticsSummary({ errors: 40, warnings: 0, items: many })
    expect(summary?.items).toHaveLength(MAX_SUMMARY_ITEMS)
    expect(summary?.items?.[0]?.line).toBe(1)
    expect(summary?.errors).toBe(40)
  })

  it('keeps per-file counts of a multi-file edit and drops the ones that say nothing', () => {
    const files = [{ path: 'src/a.ts', errors: 2, warnings: 1 }, { path: 'src/b.ts', errors: 0, warnings: 0 }, { path: '', errors: 1, warnings: 0 }, { path: 'src/c.ts', errors: 'x', warnings: 0 }, { path: 'src/d.ts', errors: 1, warnings: 0 }]
    expect(sanitizeDiagnosticsSummary({ errors: 4, warnings: 1, files })?.files).toEqual([{ path: 'src/a.ts', errors: 2, warnings: 1 }, { path: 'src/d.ts', errors: 1, warnings: 0 }])
    expect(sanitizeDiagnosticsSummary({ errors: 1, warnings: 0, files: [] })).toEqual({ errors: 1, warnings: 0 })
  })

  it('bounds the number of files it keeps', () => {
    const files = Array.from({ length: 80 }, (_, index) => ({ path: `src/f${index}.ts`, errors: 1, warnings: 0 }))
    expect(sanitizeDiagnosticsSummary({ errors: 80, warnings: 0, files })?.files).toHaveLength(MAX_SUMMARY_FILES)
  })
})
