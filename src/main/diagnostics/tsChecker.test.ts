import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { loadTypeScript, ProjectChecker, type TypeScriptApi } from './tsHost'
import type { CheckOutcome } from './tsProtocol'

const APP_DIR = resolve(__dirname, '../../..')
const temps: string[] = []

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'cubex-checker-'))
  temps.push(root)
  for (const [name, text] of Object.entries(files)) {
    const file = join(root, name)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  return root
}

const OPTIONS = { strict: true, target: 'ES2020', module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2020'], types: [], noEmit: true }
const TSCONFIG = JSON.stringify({ compilerOptions: OPTIONS, include: ['src'] })
const LIB = 'export function add(a: number, b: number): number { return a + b }\n'
const USER = 'import { add } from "./lib"\nexport const r = add(1, 2)\n'

let ts: TypeScriptApi
beforeAll(() => {
  const loaded = loadTypeScript(tmpdir(), APP_DIR)
  if ('reason' in loaded) throw new Error(loaded.reason)
  ts = loaded.ts
})
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const checker = (root: string, extra: { maxProgramFiles?: number; cancelled?: () => boolean } = {}): ProjectChecker =>
  new ProjectChecker({ ts, root, ...extra })

const codes = (outcome: CheckOutcome): string[] =>
  outcome.status === 'ok' ? (outcome.after ?? []).map((d) => d.code ?? '') : [`<${outcome.status}>`]

describe('ProjectChecker: files that change behind its back', () => {
  it('sees a change another tool made to a file the checked file imports', () => {
    const root = project({ 'tsconfig.json': TSCONFIG, 'src/lib.ts': LIB, 'src/a.ts': USER })
    const c = checker(root)
    expect(codes(c.current(join(root, 'src/a.ts')))).toEqual([])
    // An editor, git or a shell command changes the signature; the checker was never told.
    writeFileSync(join(root, 'src/lib.ts'), 'export function add(a: number): number { return a }\n')
    expect(codes(c.current(join(root, 'src/a.ts')))).toEqual(['TS2554'])
    c.dispose()
  })

  it('sees a file the project gained after the checker started', () => {
    const root = project({ 'tsconfig.json': TSCONFIG, 'src/a.ts': 'import { late } from "./late"\nexport const r: number = late\n', 'src/late.ts': 'export const late = 1\n' })
    const c = checker(root)
    expect(codes(c.current(join(root, 'src/a.ts')))).toEqual([])
    writeFileSync(join(root, 'src/late.ts'), 'export const late = "text"\n')
    expect(codes(c.current(join(root, 'src/a.ts')))).toEqual(['TS2322'])
    c.dispose()
  })

  it('leaves nothing of a checked text behind: the disk is the truth again afterwards', () => {
    const root = project({ 'tsconfig.json': TSCONFIG, 'src/a.ts': 'export const a: number = 1\n' })
    const c = checker(root)
    const file = join(root, 'src/a.ts')
    expect(codes(c.check(file, 'export const a: number = 1\n', 'export const a: number = "x"\n'))).toEqual(['TS2322'])
    // The text above was only evaluated; the file on disk is still the clean one.
    expect(codes(c.current(file))).toEqual([])
    c.dispose()
  })

  it('answers repeated questions about an unchanged file from the compiler cache', () => {
    const root = project({ 'tsconfig.json': TSCONFIG, 'src/a.ts': 'export const a: number = "x"\n' })
    const c = checker(root)
    const file = join(root, 'src/a.ts')
    const first = c.current(file)
    const started = performance.now()
    for (let index = 0; index < 20; index++) expect(c.current(file)).toEqual(first)
    expect(performance.now() - started).toBeLessThan(500)
    c.dispose()
  })

  it('re-reads a tsconfig.json that changed on disk', () => {
    const root = project({ 'tsconfig.json': JSON.stringify({ compilerOptions: { ...OPTIONS, strict: false }, include: ['src'] }), 'src/a.ts': 'export function f(x) { return x }\n' })
    const c = checker(root)
    const file = join(root, 'src/a.ts')
    expect(codes(c.current(file))).toEqual([])
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { ...OPTIONS, strict: true, noImplicitAny: true }, include: ['src'] }))
    expect(codes(c.current(file))).toEqual(['TS7006'])
    c.dispose()
  })
})

describe('ProjectChecker: large projects and a missing file', () => {
  it('skips a project with more files than it will build a program for', () => {
    const root = project({ 'tsconfig.json': TSCONFIG, 'src/a.ts': 'export const a = 1\n', 'src/b.ts': 'export const b = 1\n', 'src/c.ts': 'export const c = 1\n' })
    const c = checker(root, { maxProgramFiles: 2 })
    const outcome = c.current(join(root, 'src/a.ts'))
    expect(outcome).toMatchObject({ status: 'skipped', reason: expect.stringContaining('3 files, more than the 2') })
    c.dispose()
  })

  it('has nothing to say about a file that is not on disk', () => {
    const root = project({ 'tsconfig.json': TSCONFIG, 'src/a.ts': 'export const a = 1\n' })
    const c = checker(root)
    expect(c.current(join(root, 'src/gone.ts'))).toMatchObject({ status: 'skipped' })
    c.dispose()
  })

  it('stops when asked to cancel', () => {
    const root = project({ 'tsconfig.json': TSCONFIG, 'src/a.ts': 'export const a = 1\n' })
    const c = checker(root, { cancelled: () => true })
    expect(c.current(join(root, 'src/a.ts'))).toEqual({ status: 'cancelled' })
    expect(c.check(join(root, 'src/a.ts'), null, 'export const a = 2\n')).toEqual({ status: 'cancelled' })
    expect(c.warm()).toEqual({ status: 'cancelled' })
    c.dispose()
  })
})

describe('ProjectChecker.warm', () => {
  it('builds the program of the project so the next check starts from it', () => {
    const root = project({ 'tsconfig.json': TSCONFIG, 'src/lib.ts': LIB, 'src/a.ts': USER })
    const c = checker(root)
    expect(c.warm()).toEqual({ status: 'ok' })
    expect(codes(c.current(join(root, 'src/a.ts')))).toEqual([])
    c.dispose()
  })

  it('skips a folder that has no project config', () => {
    const root = project({ 'src/a.ts': 'export const a = 1\n' })
    const c = checker(root)
    expect(c.warm()).toMatchObject({ status: 'skipped' })
    c.dispose()
  })

  it('warms the projects a solution-style config references, then checks files in them', () => {
    const root = project({
      'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }),
      'tsconfig.app.json': JSON.stringify({ compilerOptions: { ...OPTIONS, composite: true }, include: ['src'] }),
      'src/a.ts': 'export const a: number = "x"\n'
    })
    const c = checker(root)
    expect(c.warm()).toEqual({ status: 'ok' })
    expect(codes(c.current(join(root, 'src/a.ts')))).toEqual(['TS2322'])
    c.dispose()
  })
})
