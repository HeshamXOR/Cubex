import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecutableTool, JSONValue, ToolExecutionContext } from '@core/types'
import type { DiagnoseHook, DiagnosticsReport, MutatedFile } from '../diagnostics/types'
import { createFileTools } from './fileTools'

const ctx = (signal?: AbortSignal): ToolExecutionContext => ({ requestPermission: async () => ({ decision: 'allow' }), ...(signal ? { signal } : {}) })

const report: DiagnosticsReport = {
  text: '\n\nNew diagnostics (1 error):\nsrc/a.ts:1:14 error TS2322: boom',
  summary: { errors: 1, warnings: 0, items: [{ path: 'src/a.ts', line: 1, col: 14, code: 'TS2322', message: 'boom' }] }
}

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cubex-ft-diag-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a: number = 1\n')
  writeFileSync(join(root, 'src', 'b.ts'), 'export const b = 2\n')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** Tools wired to a recording hook, plus a way to run one by name. */
function setup(answer: (files: MutatedFile[]) => Promise<DiagnosticsReport | undefined> | DiagnosticsReport | undefined = () => report) {
  const calls: Array<{ files: MutatedFile[]; signal?: AbortSignal }> = []
  const hook: DiagnoseHook = async (files, signal) => {
    calls.push({ files, ...(signal ? { signal } : {}) })
    return answer(files)
  }
  const tools = createFileTools(root, undefined, hook)
  const byName = (name: string): ExecutableTool => tools.find((tool) => tool.definition.name === name)!
  const run = (name: string, input: JSONValue, signal?: AbortSignal) => byName(name).execute(input, ctx(signal))
  return { calls, run }
}

const read = (run: ReturnType<typeof setup>['run'], path: string) => run('read_file', { path })

describe('post-edit diagnostics on the file tools', () => {
  it('write_file: reports a new file with no baseline', async () => {
    const { calls, run } = setup()
    const result = await run('write_file', { path: 'src/new.ts', content: 'export const n: number = "x"\n' })
    expect(result.isError).toBeFalsy()
    expect(String(result.content)).toContain('New diagnostics (1 error):')
    expect(result.metadata?.diagnostics).toEqual(report.summary)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.files).toEqual([{ abs: join(root, 'src', 'new.ts'), before: Buffer.alloc(0), existed: false, after: 'export const n: number = "x"\n' }])
  })

  it('write_file: gives an overwritten file its previous bytes as the baseline', async () => {
    const { calls, run } = setup()
    await read(run, 'src/a.ts')
    await run('write_file', { path: 'src/a.ts', content: 'export const a: number = "x"\n' })
    expect(calls[0]!.files[0]).toMatchObject({ existed: true, after: 'export const a: number = "x"\n' })
    expect(calls[0]!.files[0]!.before.toString()).toBe('export const a: number = 1\n')
  })

  it('edit_file: passes the file as it was and as it is now', async () => {
    const { calls, run } = setup()
    await read(run, 'src/a.ts')
    const result = await run('edit_file', { path: 'src/a.ts', old_string: '= 1', new_string: '= "one"' })
    expect(String(result.content)).toContain('New diagnostics (1 error):')
    expect(calls[0]!.files).toHaveLength(1)
    expect(calls[0]!.files[0]!.before.toString()).toBe('export const a: number = 1\n')
    expect(calls[0]!.files[0]!.after).toBe('export const a: number = "one"\n')
  })

  it('multi_edit: is checked once for the whole call', async () => {
    const { calls, run } = setup()
    await read(run, 'src/a.ts')
    const result = await run('multi_edit', { path: 'src/a.ts', edits: [{ old_string: 'a:', new_string: 'aa:' }, { old_string: '= 1', new_string: '= "x"' }] })
    expect(result.metadata?.diagnostics).toEqual(report.summary)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.files[0]!.after).toBe('export const aa: number = "x"\n')
  })

  it('apply_patch: hands every file the patch changed to the checker in one call', async () => {
    const { calls, run } = setup()
    await read(run, 'src/a.ts')
    const patch = ['*** Begin Patch', '*** Update File: src/a.ts', '-export const a: number = 1', '+export const a: number = "x"', '*** Add File: src/c.ts', '+export const c = 3', '*** End Patch'].join('\n')
    const result = await run('apply_patch', { patch })
    expect(result.isError).toBeFalsy()
    expect(String(result.content)).toContain('New diagnostics')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.files.map((file) => file.abs).sort()).toEqual([join(root, 'src', 'a.ts'), join(root, 'src', 'c.ts')])
  })

  it('never fails the edit because the checker did', async () => {
    const { run } = setup(async () => { throw new Error('checker exploded') })
    const result = await run('write_file', { path: 'src/new.ts', content: 'export {}\n' })
    expect(result.isError).toBeFalsy()
    expect(String(result.content)).toContain('Wrote')
  })

  it('does not check a call that failed', async () => {
    const { calls, run } = setup()
    // The file exists and was never read, so the overwrite is refused.
    const result = await run('write_file', { path: 'src/b.ts', content: 'export const b = 3\n' })
    expect(result.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('one tool call never sees the files another changed', async () => {
    const { calls, run } = setup()
    await run('write_file', { path: 'src/one.ts', content: 'export const one = 1\n' })
    await run('write_file', { path: 'src/two.ts', content: 'export const two = 2\n' })
    expect(calls.map((call) => call.files.map((file) => file.abs))).toEqual([[join(root, 'src', 'one.ts')], [join(root, 'src', 'two.ts')]])
  })
})
