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

  it('says to install typescript when neither the workspace nor the app has one', () => {
    const root = workspace()
    const bare = mkdtempSync(join(tmpdir(), 'cubex-no-ts-'))
    temps.push(bare)
    const status = new DiagnosticsManager({ appDir: bare, workerPath: FAKE_WORKER }).status(root)
    expect(status.available).toBe(false)
    expect(status.reason).toContain('npm install -D typescript')
  })

  it('reports a missing worker as a problem with the app, not the project', () => {
    const root = workspace()
    // Run from source there is no built worker beside the bundle.
    const status = new DiagnosticsManager({ appDir: APP_DIR }).status(root)
    expect(status.available).toBe(false)
    expect(status.reason).toContain('tsWorker.js')
  })

  it('remembers the root it was last asked about', () => {
    const root = workspace()
    const m = manager()
    expect(m.lastRoot).toBeUndefined()
    m.status(root)
    expect(m.lastRoot).toBe(root)
  })
})

describe('without a worker', () => {
  it('answers undefined at once instead of checking on the main thread', async () => {
    const root = workspace()
    const m = new DiagnosticsManager({ appDir: APP_DIR })
    managers.push(m)
    const started = Date.now()
    expect(await m.check({ root, abs: join(root, 'src/a.ts'), before: null, after: 'export const b = 1\n' })).toBeUndefined()
    expect(await m.current(root, join(root, 'src/a.ts'))).toBeUndefined()
    expect(await m.getDiagnostics(root, 'src/a.ts')).toEqual([])
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe('requests', () => {
  it('returns what the worker found before and after an edit', async () => {
    const root = workspace({ before: [], after: [error()] })
    const found = await manager().check({ root, abs: join(root, 'src/a.ts'), before: 'a', after: 'b' })
    expect(found).toEqual({ before: [], after: [error()] })
  })

  it('does not check non-source files, deletions or an aborted request', async () => {
    const root = workspace({ after: [error()] })
    const m = manager()
    expect(await m.check({ root, abs: join(root, 'README.md'), before: null, after: 'x' })).toBeUndefined()
    expect(await m.check({ root, abs: join(root, 'src/a.ts'), before: 'x', after: null })).toBeUndefined()
    const aborted = AbortSignal.abort()
    expect(await m.check({ root, abs: join(root, 'src/a.ts'), before: null, after: 'x' }, aborted)).toBeUndefined()
    expect(lines(root)).toEqual([])
  })

  it('times each request from when the worker starts it, not from when it was asked for', async () => {
    const root = workspace({ delayMs: 120, after: [error()] })
    const m = manager({ requestMs: 300 })
    const abs = join(root, 'src/a.ts')
    // Five requests at 120 ms each take 600 ms in all: twice the limit, yet none may be given up on.
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => m.current(root, abs)))
    expect(results.every((found) => found?.length === 1)).toBe(true)
  })

  it('runs requests one at a time in the order they were asked for', async () => {
    const root = workspace({ delayMs: 30 })
    const m = manager()
    await Promise.all(['a.ts', 'b.ts', 'c.ts'].map((name) => m.current(root, join(root, 'src', name))))
    expect(lines(root).filter((line) => line.startsWith('current'))).toEqual(['current:a.ts', 'current:b.ts', 'current:c.ts'])
  })

  it('drops a queued request whose caller gave up, and still answers the others', async () => {
    const root = workspace({ delayMs: 150 })
    const m = manager()
    const abort = new AbortController()
    const first = m.current(root, join(root, 'src/a.ts'))
    const second = m.current(root, join(root, 'src/b.ts'), abort.signal)
    const third = m.current(root, join(root, 'src/c.ts'))
    abort.abort()
    expect(await second).toBeUndefined()
    expect(await first).toEqual([])
    expect(await third).toEqual([])
    expect(lines(root).filter((line) => line.startsWith('current'))).toEqual(['current:a.ts', 'current:c.ts'])
  })

  it('lists the problems of one file through getDiagnostics, keeping warnings distinct', async () => {
    const root = workspace({ after: [error(), error({ line: 9, severity: 'warning', code: 'TS6133', message: 'unused' })] })
    const items = await manager().getDiagnostics(root, 'src/a.ts')
    expect(items).toEqual([
      { path: 'src/a.ts', line: 3, col: 7, code: 'TS2322', message: "Type 'string' is not assignable to type 'number'." },
      { path: 'src/a.ts', line: 9, col: 7, code: 'TS6133', severity: 'warning', message: 'unused' }
    ])
  })

  it('without a path, covers the files it has been asked about in that workspace', async () => {
    const root = workspace({ after: [error()] })
    const m = manager()
    expect(await m.getDiagnostics(root)).toEqual([])
    await m.current(root, join(root, 'src/a.ts'))
    await m.current(root, join(root, 'src/b.ts'))
    expect(await m.getDiagnostics(root)).toHaveLength(2)
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

  it('shuts down a worker that never answers and starts a fresh one on a later request', async () => {
    const root = workspace({ behavior: 'deaf' })
    const m = manager({ requestMs: 80, coldMs: 600, stuckMs: 150 })
    const abs = join(root, 'src/a.ts')
    expect(await m.current(root, abs)).toBeUndefined()
    await new Promise((done) => setTimeout(done, 400))
    expect(m.status(root)).toMatchObject({ available: false, reason: expect.stringContaining('stopped answering') })

    steer(root, { after: [error()] })
    expect(await m.current(root, abs)).toHaveLength(1)
    expect(starts(root)).toBe(2)
    expect(m.status(root).available).toBe(true)
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

  it('treats a worker that cannot start as permanently unavailable, with its reason', async () => {
    const root = workspace({ startup: 'unavailable' })
    const m = manager()
    const abs = join(root, 'src/a.ts')
    expect(await m.current(root, abs)).toBeUndefined()
    expect(m.status(root)).toMatchObject({ available: false, reason: 'fake: this compiler has no language service' })
    expect(await m.current(root, abs)).toBeUndefined()
    expect(starts(root)).toBe(1)
  })

  it('reports a worker that throws while starting', async () => {
    const root = workspace({ startup: 'crash' })
    const m = manager()
    expect(await m.current(root, join(root, 'src/a.ts'))).toBeUndefined()
    expect(m.status(root).reason).toContain('fake startup crash')
  })
})

describe('session lifetime', () => {
  it('gives the worker back after the workspace has been idle, and starts another on demand', async () => {
    const root = workspace({ after: [error()] })
    const m = manager({ idleMs: 150 })
    const abs = join(root, 'src/a.ts')
    expect(await m.current(root, abs)).toHaveLength(1)
    await new Promise((done) => setTimeout(done, 450))
    expect(await m.current(root, abs)).toHaveLength(1)
    expect(starts(root)).toBe(2)
  })

  it('settles every waiting request when it is disposed', async () => {
    const root = workspace({ delayMs: 400 })
    const m = manager()
    const waiting = [m.current(root, join(root, 'src/a.ts')), m.current(root, join(root, 'src/b.ts'))]
    await new Promise((done) => setTimeout(done, 100))
    m.dispose()
    expect(await Promise.all(waiting)).toEqual([undefined, undefined])
  })

  it('warms the workspace by asking its worker to build the program', async () => {
    const root = workspace()
    const m = manager()
    m.warm(root)
    await new Promise((done) => setTimeout(done, 300))
    expect(lines(root)).toEqual(['start', 'warm'])
  })

  it('does not start a worker to warm a folder that cannot be checked', async () => {
    const root = workspace()
    rmSync(join(root, 'tsconfig.json'))
    manager().warm(root)
    await new Promise((done) => setTimeout(done, 150))
    expect(lines(root)).toEqual([])
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

  it('treats a new file as having no baseline, so every problem in it is new', async () => {
    const root = workspace({ after: [error(), error({ line: 4 })] })
    const report = await manager().createDiagnoseHook(root)([written(root, 'src/new.ts', null, 'z')])
    expect(report?.summary.errors).toBe(2)
  })

  it('skips deleted files and files that are not source', async () => {
    const root = workspace({ after: [error()] })
    const hook = manager().createDiagnoseHook(root)
    expect(await hook([written(root, 'src/a.ts', 'x', null), written(root, 'notes.md', 'x', 'y')])).toBeUndefined()
    expect(lines(root)).toEqual([])
  })

  it('gives up quietly when a project is too slow for the edit to wait', async () => {
    const root = workspace({ delayMs: 700, after: [error()] })
    const hook = manager({ hookMs: 150, requestMs: 5_000, coldMs: 5_000 }).createDiagnoseHook(root)
    const started = Date.now()
    expect(await hook([written(root, 'src/a.ts', 'x', 'y')])).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(600)
  })

  it('stops when the tool call is cancelled', async () => {
    const root = workspace({ delayMs: 300, after: [error()] })
    const hook = manager().createDiagnoseHook(root)
    const turn = new AbortController()
    const pending = hook([written(root, 'src/a.ts', 'x', 'y')], turn.signal)
    turn.abort()
    expect(await pending).toBeUndefined()
  })
})
