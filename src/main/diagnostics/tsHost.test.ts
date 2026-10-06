import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { loadTypeScript, ProjectChecker, type TypeScriptApi } from './tsHost'
import type { CheckOutcome } from './tsProtocol'

// The repo's own typescript package stands in for "a typescript the app can find".
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

const TSCONFIG = JSON.stringify({
  compilerOptions: { strict: true, target: 'ES2020', module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2020'], types: [], noEmit: true },
  include: ['src']
})

let ts: TypeScriptApi
beforeAll(() => {
  const loaded = loadTypeScript(tmpdir(), APP_DIR)
  if ('reason' in loaded) throw new Error(loaded.reason)
  ts = loaded.ts
})
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function checker(root: string, extra: { maxProgramFiles?: number; cancelled?: () => boolean } = {}): ProjectChecker {
  return new ProjectChecker({ ts, root, cancelled: extra.cancelled ?? (() => false), ...(extra.maxProgramFiles ? { maxProgramFiles: extra.maxProgramFiles } : {}) })
}

function ok(outcome: CheckOutcome): Extract<CheckOutcome, { status: 'ok' }> {
  if (outcome.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(outcome)}`)
  return outcome
}

describe('loadTypeScript', () => {
  it('prefers the typescript package of the workspace', () => {
    const root = project({
      'node_modules/typescript/package.json': '{"name":"typescript","version":"9.9.9","main":"./lib/typescript.js"}',
      'node_modules/typescript/lib/typescript.js': 'module.exports = { version: "9.9.9", createLanguageService() {} }'
    })
    const loaded = loadTypeScript(root, APP_DIR)
    expect('ts' in loaded && loaded.source).toBe('workspace')
    expect('ts' in loaded && loaded.version).toBe('9.9.9')
  })

  it('falls back to the app package when the workspace has none or an unusable one', () => {
    const none = loadTypeScript(project({ 'a.txt': 'x' }), APP_DIR)
    expect('ts' in none && none.source).toBe('app')
    const unusable = project({
      'node_modules/typescript/package.json': '{"name":"typescript","version":"7.0.0","main":"./lib/typescript.js"}',
      'node_modules/typescript/lib/typescript.js': 'module.exports = { version: "7.0.0" }'
    })
    const loaded = loadTypeScript(unusable, APP_DIR)
    expect('ts' in loaded && loaded.source).toBe('app')
  })

  it('reports why when no typescript is found anywhere', () => {
    const loaded = loadTypeScript(project({ 'a.txt': 'x' }), undefined)
    expect('reason' in loaded && loaded.reason).toMatch(/typescript/i)
  })
})

describe('ProjectChecker: errors around an edit', () => {
  it('reports the new error after an edit and none before it', () => {
    const root = project({ 'tsconfig.json': TSCONFIG, 'src/a.ts': 'export const a: number = 1\n' })
    const c = checker(root)
    const after = 'export const a: number = "one"\n'
    const result = ok(c.check(join(root, 'src/a.ts'), 'export const a: number = 1\n', after))
    expect(result.before).toEqual([])
    expect(result.after).toHaveLength(1)
    expect(result.after![0]).toMatchObject({
      path: 'src/a.ts', line: 1, col: 14, severity: 'error', code: 'TS2322',
      message: "Type 'string' is not assignable to type 'number'.", context: 'export const a: number = "one"'
    })
    c.dispose()
  })

  it('sees a pre-existing error on both sides, at its new line after an insertion above it', () => {
    const root = project({ 'tsconfig.json': TSCONFIG, 'src/a.ts': 'export const a: number = "x"\n' })
    const c = checker(root)
    const result = ok(c.check(join(root, 'src/a.ts'), 'export const a: number = "x"\n', '// header\nexport const a: number = "x"\n'))
    expect(result.before).toHaveLength(1)
    expect(result.after).toHaveLength(1)
    expect(result.before![0]!.line).toBe(1)
    expect(result.after![0]!.line).toBe(2)
    c.dispose()
  })

  it('finds errors that come from another file, using the edited text of this one', () => {
    const root = project({
      'tsconfig.json': TSCONFIG,
      'src/lib.ts': 'export function add(a: number, b: number): number { return a + b }\n',
      'src/a.ts': 'import { add } from "./lib"\nexport const r = add(1, 2)\n'
    })
    const c = checker(root)
    const result = ok(c.check(join(root, 'src/a.ts'), 'import { add } from "./lib"\nexport const r = add(1, 2)\n', 'import { add } from "./lib"\nexport const r = add(1)\n'))
    expect(result.after!.map((d) => d.code)).toEqual(['TS2554'])
    c.dispose()
  })

  it('has no baseline for a new file and still reports its errors', () => {
    const root = project({ 'tsconfig.json': TSCONFIG, 'src/a.ts': 'export const a = 1\n' })
    const c = checker(root)
    const created = join(root, 'src/new.ts')
    const result = ok(c.check(created, null, 'export const n: string = 5\n'))
    expect(result.before).toBeUndefined()
    expect(result.after!.map((d) => d.code)).toEqual(['TS2322'])
    c.dispose()
  })
})
