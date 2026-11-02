import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { RepoMapCache, buildRepoMap, extractDeclarations } from './repoMap'

const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0

describe('extractDeclarations', () => {
  it('reads top-level TypeScript signatures, joins wrapped ones and ignores nested code', () => {
    const text = [
      "import { x } from './x'",
      'export async function load(',
      '  path: string,',
      '  retries = 3',
      '): Promise<Buffer> {',
      '  function inner() {}',
      '}',
      'export class Store extends Base<Item> {',
      '  method() {}',
      '}',
      'export interface Options { a: 1 }',
      'export const LIMIT = 10',
      'export const parse = (input: string): number => {',
      '  return 1',
      '}',
      'const hidden = 1',
      'function helper() {}'
    ].join('\n')
    expect(extractDeclarations('a.ts', text)).toEqual([
      'async function load( path: string, retries = 3 ): Promise<Buffer>',
      'class Store extends Base<Item>',
      'interface Options { a: 1 }',
      'const LIMIT',
      'const parse = (input: string): number'
    ])
  })

  it('falls back to private declarations when nothing is exported', () => {
    expect(extractDeclarations('a.js', 'function run() {}\nconst go = () => {}\nconst n = 1')).toEqual(['function run()', 'const go = ()'])
  })

  it('covers Python, Go, Rust and Kotlin', () => {
    expect(extractDeclarations('a.py', 'class A:\n    def m(self): ...\ndef run(x: int) -> str:\n    pass\ndef _p(): ...')).toEqual(['class A', 'def run(x: int) -> str'])
    expect(extractDeclarations('a.go', 'func (s *Server) Start() error {\n}\nfunc helper() {}\ntype Config struct {\n}')).toEqual(['func (s *Server) Start() error', 'type Config struct'])
    expect(extractDeclarations('a.rs', 'pub fn parse(s: &str) -> Ast {\n}\nfn private() {}\npub struct Ast {\n}\nimpl Ast {\n    pub fn new() {}\n}')).toEqual(['pub fn parse(s: &str) -> Ast', 'pub struct Ast', 'impl Ast'])
    expect(extractDeclarations('A.kt', 'data class User(val id: Int)\nsuspend fun load(): User = TODO()')).toEqual(['data class User(val id: Int)', 'suspend fun load(): User = TODO()'])
  })
})

describe('repo map', () => {
  let root: string

  const write = (path: string, content: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }

  /** A small project: an entry point, a widely imported helper, a leaf, tests and folders that must be ignored. */
  const seed = (): void => {
    write('package.json', JSON.stringify({ name: 'demo', main: './dist/server.js', scripts: { build: 'tsc', test: 'vitest' } }))
    write('src/server.ts', "import { shared } from './lib/shared'\nexport function startServer(port: number): void {}\n")
    write('src/lib/shared.ts', 'export function shared(value: string): string { return value }\nexport const SHARED_LIMIT = 5\n')
    for (const name of ['a', 'b', 'c']) write(`src/features/${name}.ts`, `import { shared } from '../lib/shared'\nexport function feature_${name}(): void {}\n`)
    write('src/deep/er/est/leaf.ts', 'export function leaf(): void {}\n')
    write('src/lib/shared.test.ts', "import { shared } from './shared'\nexport function testOnly(): void {}\n")
    write('node_modules/pkg/index.js', 'export function fromNodeModules() {}\n')
    write('dist/server.js', 'export function builtOutput() {}\n')
    write('vendor/lib.go', 'package vendor\nfunc Vendored() {}\n')
    write('src/bundle.min.js', 'export function minified() {}\n')
    write('package-lock.json', '{"lockfileVersion": 3}')
    write('README.md', '# demo\n')
  }

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cubex-repomap-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('is undefined for an empty folder, a missing folder and a folder without code', async () => {
    expect(await buildRepoMap(root)).toBeUndefined()
    expect(await buildRepoMap(join(root, 'missing'))).toBeUndefined()
    write('notes.md', '# notes\n')
    write('data.json', '{}')
    expect(await buildRepoMap(root)).toBeUndefined()
  })

  it('introduces itself, ranks entry points and widely imported files first, and skips noise', async () => {
    seed()
    const map = (await buildRepoMap(root))!
    expect(map.split('\n')[0]).toBe('Project map: top-level files and declarations; read files before relying on details.')
    const order = (path: string): number => map.indexOf(`\n${path}`)
    // package.json main points into dist/, which maps back to the source entry.
    expect(order('src/server.ts [entry]')).toBeGreaterThan(-1)
    expect(map).toContain('function startServer(port: number): void')
    expect(order('src/server.ts')).toBeLessThan(order('src/lib/shared.ts'))
    expect(order('src/lib/shared.ts')).toBeLessThan(order('src/features/a.ts'))
    expect(order('src/features/a.ts')).toBeLessThan(order('src/deep/er/est/leaf.ts'))
    expect(map).toContain('package.json scripts: build, test')
    for (const noise of ['fromNodeModules', 'builtOutput', 'Vendored', 'minified', 'testOnly', 'lockfileVersion', 'package-lock']) expect(map).not.toContain(noise)
  })

  it('never exceeds the budget and keeps the most important file when squeezed', async () => {
    seed()
    for (let index = 0; index < 120; index++) {
      write(`src/modules/m${index}/index.ts`, Array.from({ length: 20 }, (_, n) => `export function fn_${index}_${n}(argument: string, other: number): Promise<void> {}`).join('\n'))
    }
    for (const maxChars of [700, 1500, 6000]) {
      const map = (await buildRepoMap(root, { maxChars }))!
      expect(map.length).toBeLessThanOrEqual(maxChars)
      expect(map).toContain('src/server.ts')
    }
    const roomy = (await buildRepoMap(root, { maxChars: 12_000 }))!
    expect(roomy.length).toBeLessThanOrEqual(12_000)
    expect(roomy).toMatch(/modules\/ \(120\)/)
  })

  it('lists plain folders as collapsed counts instead of file names', async () => {
    seed()
    const map = (await buildRepoMap(root))!
    const tree = map.slice(map.indexOf('Folders (file counts):'))
    expect(tree).toMatch(/src\/ \(\d+\)/)
    expect(tree).not.toContain('node_modules')
    expect(tree).not.toContain('vendor')
    expect(tree).not.toContain('leaf.ts')
  })

  it('returns undefined when aborted', async () => {
    seed()
    const controller = new AbortController()
    controller.abort()
    expect(await buildRepoMap(root, { signal: controller.signal })).toBeUndefined()
  })

  it('maps the same unchanged folder to identical text', async () => {
    seed()
    expect(await buildRepoMap(root)).toBe(await buildRepoMap(root))
  })

  describe('RepoMapCache', () => {
    it('serves the same text until a file is added, edited or removed', async () => {
      seed()
      const cache = new RepoMapCache(0) // always re-check the disk; the text must still only change with the files
      const first = (await cache.get(root))!
      expect(await cache.get(root)).toBe(first)

      write('src/added.ts', 'export function addedLater(): void {}\n')
      const second = (await cache.get(root))!
      expect(second).not.toBe(first)
      expect(second).toContain('addedLater')

      // Same size, newer mtime: an edit that keeps the file set unchanged.
      write('src/added.ts', 'export function editedNow(): void {}\n')
      const future = new Date(Date.now() + 60_000)
      utimesSync(join(root, 'src/added.ts'), future, future)
      const third = (await cache.get(root))!
      expect(third).toContain('editedNow')
      expect(third).not.toContain('addedLater')

      rmSync(join(root, 'src/added.ts'))
      expect(await cache.get(root)).toBe(first)
    })

    it('skips the disk entirely inside the freshness window and rebuilds when the budget changes', async () => {
      seed()
      const cache = new RepoMapCache(60_000)
      const first = (await cache.get(root))!
      write('src/added.ts', 'export function addedLater(): void {}\n')
      expect(await cache.get(root)).toBe(first)
      const smaller = (await cache.get(root, { maxChars: 800 }))!
      expect(smaller.length).toBeLessThanOrEqual(800)
      expect(smaller).not.toBe(first)
      cache.clear(root)
      expect(await cache.get(root)).toContain('addedLater')
    })

    it('shares one build between concurrent callers', async () => {
      seed()
      const cache = new RepoMapCache(0)
      const [a, b] = await Promise.all([cache.get(root), cache.get(root)])
      expect(a).toBeDefined()
      expect(a).toBe(b)
    })
  })
})

describe.skipIf(!hasGit)('repo map in a git repository', () => {
  let root: string
  const git = (...args: string[]): string => execFileSync('git', [
    '-c', 'user.name=Cubex Test', '-c', 'user.email=cubex@example.invalid', '-c', 'commit.gpgsign=false', ...args
  ], { cwd: root, windowsHide: true, encoding: 'utf8' })
  const write = (path: string, content: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cubex-repomap-git-'))
    git('init', '-q')
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('honours .gitignore, includes untracked files and favours recently committed files', async () => {
    write('.gitignore', 'secret/\n')
    write('secret/keys.ts', 'export function leakedKey(): void {}\n')
    write('src/old.ts', 'export function oldThing(): void {}\n')
    write('src/fresh.ts', 'export function freshThing(): void {}\n')
    git('add', '.gitignore', 'src/old.ts')
    git('commit', '-q', '-m', 'old')
    git('add', 'src/fresh.ts')
    git('commit', '-q', '-m', 'fresh')
    write('src/untracked.ts', 'export function untrackedThing(): void {}\n')

    const map = (await buildRepoMap(root))!
    expect(map).not.toContain('leakedKey')
    expect(map).toContain('untrackedThing')
    expect(map.indexOf('src/fresh.ts')).toBeLessThan(map.indexOf('src/old.ts'))
  })

  it('keeps the text across a commit that changes nothing and then picks up a new file', async () => {
    write('src/one.ts', 'export function one(): void {}\n')
    git('add', '.')
    git('commit', '-q', '-m', 'one')
    const cache = new RepoMapCache(0)
    const before = await cache.get(root)
    git('commit', '-q', '--allow-empty', '-m', 'empty')
    expect(await cache.get(root)).toBe(before)
    write('src/two.ts', 'export function two(): void {}\n')
    expect(await cache.get(root)).toContain('two')
  })
})
