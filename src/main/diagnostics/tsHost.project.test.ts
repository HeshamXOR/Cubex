import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { loadTypeScript, ProjectChecker, type TypeScriptApi } from './tsHost'
import type { CheckOutcome } from './tsProtocol'

const APP_DIR = resolve(__dirname, '../../..')
const temps: string[] = []

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'cubex-diag-'))
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
  new ProjectChecker({ ts, root, cancelled: extra.cancelled ?? (() => false), ...(extra.maxProgramFiles ? { maxProgramFiles: extra.maxProgramFiles } : {}) })

const codes = (outcome: CheckOutcome): string[] =>
  outcome.status === 'ok' ? (outcome.after ?? []).map((d) => d.code ?? '') : [`<${outcome.status}>`]

describe('ProjectChecker: which project owns a file', () => {
  it('skips a workspace with no tsconfig or jsconfig, and files the config does not include', () => {
    const bare = project({ 'src/a.ts': 'export const a: number = "x"\n' })
    const c1 = checker(bare)
    expect(c1.check(join(bare, 'src/a.ts'), 'x', 'export const a: number = "x"\n')).toMatchObject({ status: 'skipped' })
    const excluded = project({ 'tsconfig.json': TSCONFIG, 'scripts/b.ts': 'export const b: number = "x"\n' })
    const c2 = checker(excluded)
    expect(c2.check(join(excluded, 'scripts/b.ts'), 'x', 'export const b: number = "x"\n')).toMatchObject({ status: 'skipped' })
    c1.dispose()
    c2.dispose()
  })

  it('skips extensions the checker does not handle', () => {
    const root = project({ 'tsconfig.json': TSCONFIG, 'src/a.css': 'a{}' })
    const c = checker(root)
    expect(c.check(join(root, 'src/a.css'), null, 'a{}')).toMatchObject({ status: 'skipped' })
    c.dispose()
  })

  it('uses the nearest config walking up from the file', () => {
    const root = project({
      'tsconfig.json': JSON.stringify({ compilerOptions: { ...OPTIONS, strict: false }, include: ['**/*'] }),
      'pkg/tsconfig.json': JSON.stringify({ compilerOptions: OPTIONS, include: ['src'] }),
      'pkg/src/a.ts': 'export function f(x) { return x }\n'
    })
    const c = checker(root)
    expect(codes(c.check(join(root, 'pkg/src/a.ts'), null, 'export function f(x) { return x }\n'))).toEqual(['TS7006'])
    c.dispose()
  })

  it('finds the referenced project that includes the file in a solution-style root config', () => {
    const root = project({
      'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }),
      'tsconfig.app.json': JSON.stringify({ compilerOptions: { ...OPTIONS, composite: true }, include: ['src'] }),
      'src/a.ts': 'export const a: number = 1\n'
    })
    const c = checker(root)
    expect(codes(c.check(join(root, 'src/a.ts'), 'export const a: number = 1\n', 'export const a: number = "x"\n'))).toEqual(['TS2322'])
    c.dispose()
  })

  it('reports syntax errors in a javascript file of a jsconfig project', () => {
    const root = project({ 'jsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2020', module: 'ESNext' }, include: ['src'] }), 'src/a.js': 'export const a = 1\n' })
    const c = checker(root)
    const result = c.check(join(root, 'src/a.js'), 'export const a = 1\n', 'export const a = (1\n')
    expect(result.status).toBe('ok')
    expect(codes(result).length).toBeGreaterThan(0)
    c.dispose()
  })
})

describe('ProjectChecker: nothing outside the workspace is read', () => {
  it('treats an import of a file outside the workspace as unresolved', () => {
    const outer = project({ 'secret.ts': 'export const secret: number = 42\n' })
    const root = project({ 'tsconfig.json': TSCONFIG, 'src/a.ts': 'export const a = 1\n' })
    const target = outer.replace(/\\/g, '/') + '/secret'
    const c = checker(root)
    const text = `import { secret } from "${target}"\nexport const v: number = secret\n`
    expect(codes(c.check(join(root, 'src/a.ts'), 'export const a = 1\n', text))).toContain('TS2307')
    c.dispose()
  })

  it('does not follow a tsconfig extends that points outside the workspace', () => {
    const outer = project({ 'base.json': JSON.stringify({ compilerOptions: { strict: true } }) })
    const root = project({
      'tsconfig.json': JSON.stringify({ extends: join(outer, 'base.json'), compilerOptions: { target: 'ES2020', lib: ['ES2020'], types: [] }, include: ['src'] }),
      'src/a.ts': 'export const a = 1\n'
    })
    const c = checker(root)
    const outcome = c.check(join(root, 'src/a.ts'), 'export const a = 1\n', 'export function f(x) { return x }\n')
    // Strictness came from the outside file, which was not read: no implicit-any error is reported.
    expect(codes(outcome)).not.toContain('TS7006')
    c.dispose()
  })

  it('refuses a file argument that lies outside the workspace', () => {
    const outer = project({ 'x.ts': 'export const x: number = "s"\n' })
    const root = project({ 'tsconfig.json': TSCONFIG, 'src/a.ts': 'export const a = 1\n' })
    const c = checker(root)
    expect(c.check(join(outer, 'x.ts'), null, 'export const x: number = "s"\n')).toMatchObject({ status: 'skipped' })
    expect(c.current(join(outer, 'x.ts'))).toMatchObject({ status: 'skipped' })
    c.dispose()
  })
})
