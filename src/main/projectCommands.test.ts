import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ProjectCommandStore, canonicalCheck, detectCheckCommands, isCheckCommand, needsCheck, projectKey, renderProjectCommands, suggestChecks, worthChecking
} from './projectCommands'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cubex-project-commands-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(root, 'p-'))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}
const commands = (dir: string): string[] => detectCheckCommands(dir).map((entry) => entry.command)

describe('detectCheckCommands', () => {
  it('reads the scripts of package.json, type check first, with the package manager the lockfile names', () => {
    const scripts = JSON.stringify({ scripts: { build: 'tsc', test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit', dev: 'vite' } })
    expect(commands(project({ 'package.json': scripts }))).toEqual(['npm run typecheck', 'npm test', 'npm run lint', 'npm run build'])
    expect(commands(project({ 'package.json': scripts, 'pnpm-lock.yaml': '' }))[1]).toBe('pnpm test')
    expect(commands(project({ 'package.json': scripts, 'yarn.lock': '' }))[0]).toBe('yarn run typecheck')
    // `bun test` is Bun's own runner, not the package's script.
    expect(commands(project({ 'package.json': scripts, 'bun.lockb': '' }))[1]).toBe('bun run test')
  })

  it('does not offer the placeholder test script or a script that is not there', () => {
    expect(commands(project({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }))).toEqual([])
    expect(commands(project({ 'package.json': '{ not json' }))).toEqual([])
  })

  it('finds Python, Rust, Go, Make, .NET and JVM projects', () => {
    expect(commands(project({ 'pyproject.toml': '[tool.pytest.ini_options]\n[tool.ruff]\n', 'uv.lock': '' }))).toEqual(['uv run pytest', 'uv run ruff check .'])
    expect(commands(project({ 'pytest.ini': '[pytest]\n' }))).toEqual(['pytest'])
    expect(commands(project({ 'Cargo.toml': '[package]' }))).toEqual(['cargo check', 'cargo test', 'cargo build'])
    expect(commands(project({ 'go.mod': 'module x' }))).toEqual(['go build ./...', 'go test ./...', 'go vet ./...'])
    expect(commands(project({ Makefile: 'build:\n\tcc x.c\ntest: build\n\t./a.out\nclean:\n\trm a.out\nCC := gcc\n' }))).toEqual(['make test', 'make build'])
    expect(commands(project({ 'App.sln': '' }))).toEqual(['dotnet build', 'dotnet test'])
    expect(commands(project({ 'build.gradle.kts': '', gradlew: '' }))).toEqual(['./gradlew test', './gradlew build'])
    expect(commands(project({ 'pom.xml': '' }))).toEqual(['mvn compile', 'mvn test'])
  })

  it('gives nothing for a folder with no build files or no folder at all', () => {
    expect(commands(project({ 'notes.txt': 'hi' }))).toEqual([])
    expect(detectCheckCommands(join(root, 'missing'))).toEqual([])
    expect(detectCheckCommands(undefined)).toEqual([])
  })
})

describe('isCheckCommand', () => {
  it('knows the usual ways to run tests, a type check, a linter or a build', () => {
    for (const command of [
      'npm test', 'npm test -- --run src/a.test.ts', 'npm run typecheck:node', 'pnpm --filter app test', 'yarn lint', 'bun run build',
      'npx tsc --noEmit -p tsconfig.json', 'npx vitest run', 'pytest -q', 'python -m pytest tests', 'uv run pytest', 'cargo test', 'cargo check --all',
      'go test ./...', 'go vet ./...', 'make test', 'make', './gradlew test', 'mvn verify', 'dotnet build', 'dotnet test', 'cd app && npm run lint',
      'CI=1 npm test', 'eslint src'
    ]) expect(isCheckCommand(command), command).toBe(true)
  })

  it('does not take other commands for a check', () => {
    for (const command of [
      'npm install', 'npm ci', 'npm run dev', 'git status', 'cat test.txt', 'echo build', 'node script.js', 'cargo run', 'go run .', 'tsc --init', 'ls -la', 'yarn add vitest'
    ]) expect(isCheckCommand(command), command).toBe(false)
  })

  it('does not trust an exit status that is not the check\'s own', () => {
    expect(isCheckCommand('node --test')).toBe(true)
    expect(isCheckCommand('python tests\\test_parse.py')).toBe(true)
    expect(isCheckCommand('node src/index.js')).toBe(false)
    expect(isCheckCommand('bun test')).toBe(true)
    expect(isCheckCommand('deno test')).toBe(true)
    expect(isCheckCommand('npm test | tail -20')).toBe(false)
    expect(isCheckCommand('npm test || true')).toBe(false)
  })

  it('takes a command the project is known to use, with arguments', () => {
    expect(isCheckCommand('./scripts/verify.sh')).toBe(false)
    expect(isCheckCommand('./scripts/verify.sh', ['./scripts/verify.sh'])).toBe(true)
    expect(isCheckCommand('./scripts/verify.sh --fast', ['./scripts/verify.sh'])).toBe(true)
  })
})

describe('helpers', () => {
  it('shortens a run of a known check to the check, and keeps anything else as is', () => {
    const detected = [{ command: 'npm test', kind: 'test' as const }]
    expect(canonicalCheck('npm  test -- src/a.test.ts', detected)).toBe('npm test')
    expect(canonicalCheck('make lint', detected)).toBe('make lint')
  })

  it('leaves documentation and text edits without a check', () => {
    expect(needsCheck('README.md')).toBe(false)
    expect(worthChecking(['index.html', 'style.css'], [])).toBe(false)
    expect(worthChecking(['index.html'], ['npm test'])).toBe(true)
    expect(worthChecking(['src/a.py'], [])).toBe(true)
    expect(needsCheck('docs/notes.txt')).toBe(false)
    expect(needsCheck('src/a.ts')).toBe(true)
  })

  it('writes the prompt section with remembered commands first, and suggests them first', () => {
    const detected = [{ command: 'npm run typecheck', kind: 'typecheck' as const }, { command: 'npm test', kind: 'test' as const }]
    const text = renderProjectCommands(['npm test'], detected)!
    expect(text.indexOf('have passed in this project before')).toBeLessThan(text.indexOf('- npm run typecheck'))
    expect(text.match(/- npm test/g)).toHaveLength(1)
    expect(renderProjectCommands([], [])).toBeUndefined()
    expect(suggestChecks(['npm test'], detected, 2)).toEqual(['npm test', 'npm run typecheck'])
  })
})

describe('ProjectCommandStore', () => {
  const file = (): string => join(root, 'data', 'project-commands.json')

  it('keeps the newest first, six at most, one entry per command, and writes them atomically on flush', () => {
    const store = new ProjectCommandStore(file(), { debounceMs: 60_000 })
    const workspace = join(root, 'repo')
    for (const command of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) store.remember(workspace, `npm run ${command}`)
    store.remember(workspace, 'npm run e')
    expect(store.list(workspace)).toEqual(['npm run e', 'npm run g', 'npm run f', 'npm run d', 'npm run c', 'npm run b'])
    // Nothing is on disk until the debounce passes or flush is called.
    expect(existsSync(file())).toBe(false)
    store.flush()
    expect(JSON.parse(readFileSync(file(), 'utf8')).projects[projectKey(workspace)].commands).toHaveLength(6)
    expect(new ProjectCommandStore(file()).list(workspace)[0]).toBe('npm run e')
    expect(existsSync(`${file()}.${process.pid}.tmp`)).toBe(false)
  })

  it('calls the same folder spelled two ways one project, and a different folder another', () => {
    const store = new ProjectCommandStore(file(), { debounceMs: 60_000 })
    store.remember(join(root, 'repo'), 'npm test')
    expect(store.list(join(root, 'repo', '.'))).toEqual(['npm test'])
    expect(store.list(join(root, 'other'))).toEqual([])
  })

  it('does not remember a command that carries a secret or runs over several lines', () => {
    const store = new ProjectCommandStore(file(), { debounceMs: 60_000 })
    store.remember(root, 'API_TOKEN=abc npm test')
    store.remember(root, 'npm test\nrm -rf x')
    expect(store.list(root)).toEqual([])
  })

  it('keeps a damaged file aside instead of dropping it silently', () => {
    mkdirSync(join(root, 'data'), { recursive: true })
    writeFileSync(file(), '{ broken')
    const errors: unknown[] = []
    const store = new ProjectCommandStore(file(), { onError: (error) => errors.push(error) })
    expect(store.list(root)).toEqual([])
    expect(errors).toHaveLength(1)
    expect(existsSync(file())).toBe(false)
  })
})
