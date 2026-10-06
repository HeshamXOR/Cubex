import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiagnosticsReport, MutatedFile } from './types'
import { afterEditDiagnoseHook, disposeSharedDiagnostics, sharedDiagnostics } from './service'

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

  it('forwards the tool call signal so a cancelled turn stops the check', async () => {
    const fake = standIn()
    const signal = new AbortController().signal
    await afterEditDiagnoseHook('C:\\work', () => true, fake.source)([file], signal)
    expect(fake.hookFor).toHaveBeenCalledWith([file], signal)
  })

  it('never touches the manager while the setting is off', async () => {
    const hook = afterEditDiagnoseHook('C:\\work', () => false, () => { throw new Error('the manager must not be created') })
    expect(await hook([file])).toBeUndefined()
  })

  it('reads the setting on every call, so a change applies to the next edit', async () => {
    const fake = standIn()
    let on = false
    const hook = afterEditDiagnoseHook('C:\\work', () => on, fake.source)
    expect(await hook([file])).toBeUndefined()
    on = true
    expect(await hook([file])).toBe(report)
    on = false
    expect(await hook([file])).toBeUndefined()
    expect(fake.hookFor).toHaveBeenCalledTimes(1)
  })

  it('warms the workspace when the hook is made for a task that has the setting on, and only then', () => {
    const on = standIn()
    afterEditDiagnoseHook('C:\\work', () => true, on.source)
    expect(on.calls).toEqual(['warm C:\\work'])
    const off = standIn()
    afterEditDiagnoseHook('C:\\work', () => false, off.source)
    expect(off.calls).toEqual([])
  })
})

describe('sharedDiagnostics', () => {
  it('is one manager for the whole app, replaced only after it is disposed', () => {
    const first = sharedDiagnostics()
    expect(sharedDiagnostics()).toBe(first)
    disposeSharedDiagnostics()
    expect(sharedDiagnostics()).not.toBe(first)
  })

  it('can be disposed when it was never created', () => {
    expect(() => disposeSharedDiagnostics()).not.toThrow()
  })
})
