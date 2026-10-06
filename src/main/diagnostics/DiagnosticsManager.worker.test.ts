import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'vite'
import { DiagnosticsManager } from './DiagnosticsManager'
import type { MutatedFile } from './types'

/**
 * The real thing end to end: the checker worker is built from source the way the app builds it (a Vite SSR bundle,
 * ESM, one file next to a package.json that says so), started by DiagnosticsManager in a real worker thread, and
 * asked about real TypeScript. This is what catches a manager and a worker that no longer speak the same protocol,
 * which the fake worker in DiagnosticsManager.test.ts cannot.
 */

const APP_DIR = resolve(__dirname, '../../..')
const temps: string[] = []
let workerPath: string
const managers: DiagnosticsManager[] = []

beforeAll(async () => {
  const out = mkdtempSync(join(tmpdir(), 'cubex-worker-build-'))
  temps.push(out)
  writeFileSync(join(out, 'package.json'), '{"type":"module"}')
  await build({
    configFile: false,
    logLevel: 'silent',
    root: APP_DIR,
    build: {
      ssr: resolve(__dirname, 'tsWorker.ts'),
      outDir: out,
      emptyOutDir: false,
      minify: false,
      target: 'node20',
      rollupOptions: { output: { format: 'es', entryFileNames: 'tsWorker.js' } }
    }
  })
  workerPath = join(out, 'tsWorker.js')
}, 60_000)

afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'cubex-real-'))
  temps.push(root)
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, target: 'ES2020', module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2020'], types: [], noEmit: true },
    include: ['src']
  }))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text)
  return root
}

function manager(options: ConstructorParameters<typeof DiagnosticsManager>[0] = {}): DiagnosticsManager {
  const created = new DiagnosticsManager({ appDir: APP_DIR, workerPath, ...options })
  managers.push(created)
  return created
}

const edit = (root: string, name: string, before: string, after: string): MutatedFile => ({ abs: join(root, name), before: Buffer.from(before), existed: true, after })

describe('DiagnosticsManager with the built worker', () => {
  it('finds real type errors in a project and says which compiler checked them', async () => {
    const root = workspace({ 'src/a.ts': "export const a: number = 'x'\nexport function f(x) { return x }\n" })
    const m = manager()
    expect(m.status(root)).toMatchObject({ available: true, engine: 'typescript' })
    const items = await m.getDiagnostics(root, 'src/a.ts')
    expect(items.map((item) => `${item.line}:${item.col} ${item.code}`)).toEqual(['1:14 TS2322', '2:19 TS7006'])
    expect(items[0]!.message).toBe("Type 'string' is not assignable to type 'number'.")
    m.dispose()
  })

  it('reports only the errors an edit introduced, through the hook the file tools use', async () => {
    const before = "export const a: number = 1\nexport function f(x) { return x }\n"
    const root = workspace({ 'src/a.ts': before })
    const hook = manager().createDiagnoseHook(root)

    const broke = await hook([edit(root, 'src/a.ts', before, "export const a: number = 'x'\nexport function f(x) { return x }\n")])
    expect(broke?.summary.errors).toBe(1)
    expect(broke?.text).toBe("\n\nNew diagnostics (1 error):\nsrc/a.ts:1:14 error TS2322: Type 'string' is not assignable to type 'number'.")

    // The old implicit-any error is still there but was not introduced by this edit, and nothing new is.
    expect(await hook([edit(root, 'src/a.ts', before, "export const a: number = 2\nexport function f(x) { return x }\n")])).toBeUndefined()
  })

  it('sees an error that appears in another file when an exported signature changes', async () => {
    const lib = 'export function add(a: number, b: number): number { return a + b }\n'
    const root = workspace({ 'src/lib.ts': lib, 'src/a.ts': 'import { add } from "./lib"\nexport const r = add(1, 2)\n' })
    const m = manager()
    expect(await m.getDiagnostics(root, 'src/a.ts')).toEqual([])
    writeFileSync(join(root, 'src/lib.ts'), 'export function add(a: number): number { return a }\n')
    expect((await m.getDiagnostics(root, 'src/a.ts')).map((item) => item.code)).toEqual(['TS2554'])
  })

  it('answers repeated questions about unchanged files quickly once the program is built', async () => {
    const root = workspace({ 'src/a.ts': "export const a: number = 'x'\n" })
    const m = manager()
    m.warm(root)
    await m.getDiagnostics(root, 'src/a.ts')
    const started = Date.now()
    for (let index = 0; index < 10; index++) expect(await m.getDiagnostics(root, 'src/a.ts')).toHaveLength(1)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('survives a request that ran out of time and answers the next one', async () => {
    const root = workspace({ 'src/a.ts': "export const a: number = 'x'\n" })
    // A first request that is given 1 ms cannot finish: the worker has not even loaded the compiler.
    const m = manager({ timeouts: { coldMs: 1, requestMs: 20_000, stuckMs: 20_000 } })
    expect(await m.getDiagnostics(root, 'src/a.ts')).toEqual([])
    expect(await m.getDiagnostics(root, 'src/a.ts')).toHaveLength(1)
  })

  it('does nothing for a folder without a project config, and says why', async () => {
    const root = workspace({ 'src/a.ts': "export const a: number = 'x'\n" })
    rmSync(join(root, 'tsconfig.json'))
    const m = manager()
    expect(m.status(root)).toMatchObject({ available: false, reason: expect.stringContaining('tsconfig.json') })
    expect(await m.getDiagnostics(root, 'src/a.ts')).toEqual([])
  })
})
