import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DiagnosticsManager, type DiagnosticsTimeouts } from './DiagnosticsManager'
import type { Diagnostic, MutatedFile } from './types'

const APP_DIR = resolve(__dirname, '../../..')
const FAKE_WORKER = resolve(__dirname, '__fixtures__/fakeWorker.cjs')
const temps: string[] = []
const managers: DiagnosticsManager[] = []

interface FakeConfig {
  startup?: 'unavailable' | 'crash'
  behavior?: 'deaf' | 'crash' | 'hang'
  delayMs?: number
  before?: Diagnostic[]
  after?: Diagnostic[]
}

/** A workspace with a tsconfig.json, one source file and a fake.json that steers the fake worker. */
function workspace(config: FakeConfig = {}, files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'cubex-manager-'))
  temps.push(root)
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'tsconfig.json'), '{ "compilerOptions": { "strict": true }, "include": ["src"] }')
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(root, 'fake.json'), JSON.stringify(config))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text)
  return root
}

const steer = (root: string, config: FakeConfig): void => writeFileSync(join(root, 'fake.json'), JSON.stringify(config))
const lines = (root: string): string[] => (existsSync(join(root, 'fake.log')) ? readFileSync(join(root, 'fake.log'), 'utf8').split('\n').filter(Boolean) : [])
const starts = (root: string): number => lines(root).filter((line) => line === 'start').length

const FAST: Partial<DiagnosticsTimeouts> = { requestMs: 1_500, coldMs: 1_500, hookMs: 5_000, stuckMs: 1_000, idleMs: 60_000 }
function manager(timeouts: Partial<DiagnosticsTimeouts> = {}, workerPath: string | undefined = FAKE_WORKER): DiagnosticsManager {
  const created = new DiagnosticsManager({ appDir: APP_DIR, ...(workerPath ? { workerPath } : {}), timeouts: { ...FAST, ...timeouts } })
  managers.push(created)
  return created
}

const error = (over: Partial<Diagnostic> = {}): Diagnostic => ({
  path: 'src/a.ts', line: 3, col: 7, severity: 'error', code: 'TS2322', message: "Type 'string' is not assignable to type 'number'.", context: 'const a: number = "x"', ...over
})

afterEach(() => {
  for (const m of managers.splice(0)) m.dispose()
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('status', () => {
  it('is available for a project with a config and a typescript package', () => {
    const root = workspace()
    expect(manager().status(root)).toMatchObject({ available: true, engine: 'typescript', version: expect.stringMatching(/^\d+\./) })
  })

  it('says to add a tsconfig.json when the folder has none', () => {
    const root = workspace()
    rmSync(join(root, 'tsconfig.json'))
    const status = manager().status(root)
    expect(status.available).toBe(false)
    expect(status.reason).toContain('Add a tsconfig.json to this folder')
  })
})

describe('requests', () => {
  it('returns what the worker found before and after an edit', async () => {
    const root = workspace({ before: [], after: [error()] })
    const found = await manager().check({ root, abs: join(root, 'src/a.ts'), before: 'a', after: 'b' })
    expect(found).toEqual({ before: [], after: [error()] })
  })

  it('runs requests one at a time in the order they were asked for', async () => {
    const root = workspace({ delayMs: 30 })
    const m = manager()
    await Promise.all(['a.ts', 'b.ts', 'c.ts'].map((name) => m.current(root, join(root, 'src', name))))
    expect(lines(root).filter((line) => line.startsWith('current'))).toEqual(['current:a.ts', 'current:b.ts', 'current:c.ts'])
  })
})

describe('when a request runs out of time', () => {
  it('releases the caller, stops the check, and goes on with the next request', async () => {
    const root = workspace({ behavior: 'hang' })
    const m = manager({ requestMs: 150, coldMs: 150 })
    const abs = join(root, 'src/a.ts')
    const started = Date.now()
    expect(await m.current(root, abs)).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(1_000)
    steer(root, { after: [error()] })
    // The same worker answers again once the stopped check has finished.
    expect(await m.current(root, abs)).toHaveLength(1)
    expect(starts(root)).toBe(1)
  })
})

describe('when the worker fails', () => {
  it('settles waiting requests and restarts on the next one after a first crash', async () => {
    const root = workspace({ behavior: 'crash' })
    const m = manager()
    const abs = join(root, 'src/a.ts')
    expect(await m.current(root, abs)).toBeUndefined()
    expect(m.status(root)).toMatchObject({ available: false, reason: expect.stringContaining('exited with code 3') })

    steer(root, { after: [error()] })
    expect(await m.current(root, abs)).toHaveLength(1)
    expect(starts(root)).toBe(2)
  })

  it('stops restarting a worker that keeps dying', async () => {
    const root = workspace({ behavior: 'crash' })
    const m = manager()
    const abs = join(root, 'src/a.ts')
    await m.current(root, abs)
    await m.current(root, abs)
    // The second failure starts a cooling-off period: no third worker is started inside it.
    await m.current(root, abs)
    expect(starts(root)).toBe(2)
  })
})

describe('the after-edit hook', () => {
  const written = (root: string, name: string, before: string | null, after: string | null): MutatedFile => ({
    abs: join(root, name), before: Buffer.from(before ?? ''), existed: before !== null, after
  })

  it('reports only the problems the edit introduced', async () => {
    const old = error({ line: 1, message: 'an old problem', code: 'TS1000', context: 'old' })
    const root = workspace({ before: [old], after: [old, error()] })
    const report = await manager().createDiagnoseHook(root)([written(root, 'src/a.ts', 'x', 'y')])
    expect(report?.summary).toEqual({ errors: 1, warnings: 0, items: [{ path: 'src/a.ts', line: 3, col: 7, code: 'TS2322', message: "Type 'string' is not assignable to type 'number'." }] })
    expect(report?.text).toContain('New diagnostics (1 error)')
    expect(report?.text).toContain("src/a.ts:3:7 error TS2322: Type 'string' is not assignable to type 'number'.")
  })

  it('stays silent when the edit introduced nothing', async () => {
    const old = error()
    const root = workspace({ before: [old], after: [old] })
    expect(await manager().createDiagnoseHook(root)([written(root, 'src/a.ts', 'x', 'y')])).toBeUndefined()
  })

  it('gives up quietly when a project is too slow for the edit to wait', async () => {
    const root = workspace({ delayMs: 700, after: [error()] })
    const hook = manager({ hookMs: 150, requestMs: 5_000, coldMs: 5_000 }).createDiagnoseHook(root)
    const started = Date.now()
    expect(await hook([written(root, 'src/a.ts', 'x', 'y')])).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(600)
  })
})
