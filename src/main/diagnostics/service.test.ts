import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiagnosticsReport, MutatedFile } from './types'
import { afterEditDiagnoseHook, disposeSharedDiagnostics } from './service'

const file: MutatedFile = { abs: 'C:\\work\\a.ts', before: Buffer.from('old'), existed: true, after: 'new' }
const report: DiagnosticsReport = { text: '\n\nNew diagnostics (1 error):\nsrc/a.ts:1:1 error TS1: boom', summary: { errors: 1, warnings: 0, items: [] } }

afterEach(() => disposeSharedDiagnostics())

/** A manager stand-in that records what it was asked, and answers with `report`. */
function standIn() {
  const calls: string[] = []
  const hookFor = vi.fn(async () => report)
  return {
    calls,
    hookFor,
    source: () => ({
      warm: (root: string) => { calls.push(`warm ${root}`) },
      createDiagnoseHook: (root: string) => { calls.push(`hook ${root}`); return hookFor }
    })
  }
}

describe('afterEditDiagnoseHook', () => {
  it('passes the edit to the manager and returns its report while the setting is on', async () => {
    const fake = standIn()
    const hook = afterEditDiagnoseHook('C:\\work', () => true, fake.source)
    expect(await hook([file])).toBe(report)
    expect(fake.hookFor).toHaveBeenCalledWith([file], undefined)
    expect(fake.calls).toEqual(['warm C:\\work', 'hook C:\\work'])
  })

  it('never touches the manager while the setting is off', async () => {
    const hook = afterEditDiagnoseHook('C:\\work', () => false, () => { throw new Error('the manager must not be created') })
    expect(await hook([file])).toBeUndefined()
  })
})
