import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolCall } from '@core/types'
import { PermissionRuleStore, commandPattern, simpleCommandTokens, suggestRule, type RuleEnvironment, type SuggestContext } from './permissionRules'

let root: string
let workspace: string
const env: RuleEnvironment = { repositoryIsInert: () => true }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cubex-rules-'))
  workspace = join(root, 'my-project')
  mkdirSync(workspace)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

type Call = Pick<ToolCall, 'name' | 'input'>
const run = (command: string): Call => ({ name: 'run_command', input: { command } })
const pattern = (command: string, options: RuleEnvironment = env): string | undefined => commandPattern(command, workspace, options)
const context = (overrides: Partial<SuggestContext> = {}): SuggestContext => ({ workspace, mode: 'default', risks: [], ...env, ...overrides })

describe('simpleCommandTokens', () => {

  it.each([
    'npm test && echo hi', 'npm test; ls', 'npm test || true', 'npm test | tee out.txt', 'npm test &',
    'npm test > out.txt', 'npm test >> out.txt', 'npm test < in.txt', 'npm test 2>&1',
    'npm test $(whoami)', 'npm test `id`', 'npm test ${HOME}', '(npm test)', 'npm test {a,b}',
    'npm test\nrm -rf x', 'npm test\r\nx', 'echo %PATH%', 'npm test ^& x', 'echo !x', 'npm test\0'
  ])('rejects shell syntax: %j', (command) => {
    expect(simpleCommandTokens(command)).toBeUndefined()
  })

  it('reads quoting the way each platform shell does', () => {
    expect(simpleCommandTokens("pytest -k 'a b'", 'linux')).toEqual(['pytest', '-k', 'a b'])
    expect(simpleCommandTokens("pytest -k 'a b'", 'win32')).toBeUndefined()
    expect(simpleCommandTokens('pytest tests\\unit', 'win32')).toEqual(['pytest', 'tests\\unit'])
    expect(simpleCommandTokens('pytest tests\\unit', 'linux')).toBeUndefined()
    expect(simpleCommandTokens('pytest a\\ b', 'linux')).toBeUndefined()
  })
})

describe('commandPattern', () => {
  it.each([
    ['npm test', 'npm test'],
    ['npm test -- --coverage', 'npm test'],
    ['NPM test', 'npm test'],
    ['npm t', 'npm t'],
    ['npm start', 'npm start'],
    ['npm run build', 'npm run build'],
    ['npm  run   build -- --watch', 'npm run build'],
    ['npm run-script lint:fix', 'npm run-script lint:fix'],
    ['pnpm lint', 'pnpm lint'],
    ['pnpm test', 'pnpm test'],
    ['pnpm run test:unit', 'pnpm run test:unit'],
    ['yarn build', 'yarn build'],
    ['yarn lint:fix', 'yarn lint:fix'],
    ['bun test', 'bun test'],
    ['bun run dev', 'bun run dev'],
    ['cargo test', 'cargo test'],
    ['cargo test --release -- --nocapture', 'cargo test'],
    ['cargo clippy', 'cargo clippy'],
    ['go test ./...', 'go test'],
    ['go vet ./pkg/...', 'go vet'],
    ['dotnet test', 'dotnet test'],
    ['pytest', 'pytest'],
    ['pytest tests/test_a.py -k "foo and bar" -x', 'pytest'],
    ['python -m pytest -q', 'python -m pytest'],
    ['python3 -m unittest', 'python3 -m unittest'],
    ['tsc --noEmit', 'tsc'],
    ['eslint src --fix', 'eslint'],
    ['prettier --check "src/**/*.ts"', 'prettier'],
    ['vitest run', 'vitest'],
    ['git add src', 'git add'],
    ['git commit -m "fix typo"', 'git commit'],
    ['git status', 'git status'],
    ['git diff --stat', 'git diff']
  ])('suggests the program plus its operation: %s', (command, expected) => {
    expect(pattern(command)).toBe(expected)
  })

  it.each([
    // Shell syntax and assignments
    'npm test && rm -rf build', 'npm test; ls', 'npm test | tee out', 'npm test > out.txt', 'npm test 2>&1',
    'npm test $(whoami)', 'npm test `id`', 'NODE_ENV=production npm test', 'FOO=bar pytest', 'cd sub && npm test',
    // Interpreters, shells and inline code
    'node -e "console.log(1)"', 'node script.js', 'python -c "print(1)"', 'python script.py', 'python -m http.server',
    'bash -c "npm test"', 'sh -c "x"', 'zsh -c x', 'powershell -Command "x"', 'pwsh -c x', 'cmd /c npm test', 'env npm test',
    // Destructive, networked or privileged tools
    'rm -rf build', 'del build', 'rmdir build', 'Remove-Item build', 'curl http://example.com', 'wget http://example.com',
    'Invoke-WebRequest http://example.com', 'sudo npm test', 'runas /user:x npm', 'chmod +x run.sh', 'chown a b',
    'mv a b', 'move a b', 'xcopy a b', 'taskkill /f /im node.exe',
    // Runners that fetch or execute arbitrary packages
    'npx vitest', 'pnpm dlx create-app', 'yarn dlx x', 'bunx foo', 'bun x foo', 'npm exec foo', 'pnpm exec x',
    // Installs, publishing and cleanup
    'npm install left-pad', 'npm install', 'npm ci', 'npm publish', 'npm run deploy', 'npm run publish:prod', 'npm run clean',
    'npm run build:deploy', 'npm run', 'npm run ../x', 'npm run ./script', 'pnpm add x', 'pnpm install', 'pnpm release', 'yarn add x',
    'yarn publish', 'bun run index.ts', 'bun build ./x.ts', 'cargo run', 'cargo install foo', 'cargo publish', 'cargo clean',
    'go run main.go', 'go generate ./...', 'go install x', 'go get x', 'go mod tidy', 'dotnet run', 'pip install x',
    // git operations that rewrite, delete or reach the network
    'git push', 'git push origin main', 'git reset --hard', 'git clean -fd', 'git checkout -- .', 'git checkout main',
    'git rebase main', 'git stash', 'git merge x', 'git pull', 'git fetch', 'git restore .', 'git config user.name x',
    'git -c core.pager=x status', 'git -C .. status', 'git',
    // Unknown programs and program paths
    'make test', 'foo --bar', './node_modules/.bin/vitest', '.\\run.bat', '../tool test', 'C:\\tools\\npm test',
    // Paths outside the workspace, or options that redirect the tool
    'npm test ../other', 'npm test -- ../../x', 'pytest /etc/passwd', 'pytest ~/x', 'pytest ~', 'pytest //server/share',
    'cargo test --manifest-path ../x/Cargo.toml', 'cargo test --manifest-path=sub/Cargo.toml', 'go test ../x',
    'npm test --prefix ../x', 'npm test --prefix=other', 'npm test --script-shell=sh', 'npm test --cwd x',
    'cargo test --config build.rustc=evil', 'go test -exec evil ./...', 'go build -toolexec=evil', 'prettier --write ../x',
    'git add ../x', 'git commit -C HEAD'
  ])('never suggests: %s', (command) => {
    expect(pattern(command)).toBeUndefined()
  })

  it('stays inside the workspace even for in-tree paths with dots', () => {
    expect(pattern('pytest tests/unit')).toBe('pytest')
    expect(pattern('pytest ./tests/unit')).toBe('pytest')
    expect(pattern('pytest tests/../../escape')).toBeUndefined()
  })

  it('refuses a program that a workspace file would shadow', () => {
    writeFileSync(join(workspace, 'npm.cmd'), '@echo hijacked')
    expect(pattern('npm test', { ...env, platform: 'win32' })).toBeUndefined()
    expect(pattern('npm test', { ...env, platform: 'linux' })).toBe('npm test')
  })

  it('requires an inert repository configuration for git', () => {
    expect(pattern('git add .', { repositoryIsInert: () => false })).toBeUndefined()
    expect(pattern('git commit -m "x"', { repositoryIsInert: () => false })).toBeUndefined()
    expect(pattern('npm test', { repositoryIsInert: () => false })).toBe('npm test')
  })
})

describe('suggestRule', () => {

  it('never suggests for deletion, plans, questions or unknown tools', () => {
    for (const name of ['remove_file', 'exit_plan_mode', 'ask_user_question', 'todo_write', 'read_file', 'made_up_tool']) {
      expect(suggestRule({ name, input: { path: 'a.ts' } }, context())).toBeUndefined()
    }
  })

  it('gives a call that carries risks no rule, whatever the tool', () => {
    const risks = ['Protected path: changes here can alter how git, Cubex or other tools execute.']
    const calls: Call[] = [
      run('npm test'), { name: 'edit_file', input: { path: '.git/config' } }, { name: 'write_file', input: { path: '.claude/x' } },
      { name: 'web_fetch', input: { url: 'https://example.com/' } }, { name: 'mcp__a__b', input: {} }, { name: 'delegate_to_subagent', input: {} }
    ]
    for (const call of calls) {
      expect(suggestRule(call, context({ risks }))).toBeUndefined()
      expect(suggestRule(call, context())).toBeDefined()
    }
  })
})

describe('PermissionRuleStore', () => {
  const file = (): string => join(root, 'data', 'permission-rules.json')
  const store = (options: ConstructorParameters<typeof PermissionRuleStore>[1] = env): PermissionRuleStore => new PermissionRuleStore(file(), options)

  it('saves, lists and removes rules, and survives a restart', () => {
    const rules = store()
    const saved = rules.add(workspace, { tool: 'run_command', pattern: 'npm test', label: 'npm test' })
    rules.add(workspace, { tool: 'edit_file', pattern: '*', label: 'Edits in my-project' })
    expect(rules.list(workspace).map((rule) => rule.pattern)).toEqual(['npm test', '*'])
    expect(saved).toMatchObject({ workspace, tool: 'run_command', pattern: 'npm test', label: 'npm test' })
    expect(saved.id).toMatch(/^rule_/)
    expect(typeof saved.createdAt).toBe('number')

    // A fresh instance reads the same file: persistence, not just a cache.
    const reloaded = store()
    expect(reloaded.list()).toEqual(rules.list())
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toMatchObject({ version: 1, rules: [{ id: saved.id }, {}] })
    expect(readdirSync(join(root, 'data')).filter((name) => name.endsWith('.tmp'))).toEqual([])

    expect(reloaded.remove(saved.id)).toBe(true)
    expect(reloaded.remove(saved.id)).toBe(false)
    expect(store().list().map((rule) => rule.tool)).toEqual(['edit_file'])
  })

  it('matches commands by their own pattern, with later arguments allowed', () => {
    const rules = store()
    rules.add(workspace, { tool: 'run_command', pattern: 'npm test', label: 'npm test' })
    rules.add(workspace, { tool: 'run_command', pattern: 'npm run build', label: 'npm run build' })
    const allowed = (command: string): boolean => rules.find(workspace, run(command)) !== undefined
    expect(allowed('npm test')).toBe(true)
    expect(allowed('npm test -- --coverage')).toBe(true)
    expect(allowed('npm   test')).toBe(true)
    expect(allowed('npm run build')).toBe(true)
    expect(allowed('npm run build -- --watch')).toBe(true)
    // Different script, subcommand or program: never covered.
    expect(allowed('npm run build:prod')).toBe(false)
    expect(allowed('npm run builder')).toBe(false)
    expect(allowed('npm run Build')).toBe(false)
    expect(allowed('npm run test')).toBe(false)
    expect(allowed('npm testing')).toBe(false)
    expect(allowed('npm')).toBe(false)
    expect(allowed('pnpm test')).toBe(false)
  })

  it('requires later commands to be simple and inside the workspace too', () => {
    const rules = store()
    rules.add(workspace, { tool: 'run_command', pattern: 'npm test', label: 'npm test' })
    for (const command of [
      'npm test && curl http://example.com', 'npm test; rm -rf x', 'npm test | sh', 'npm test > ../out', 'npm test $(whoami)',
      'FOO=bar npm test', 'npm test ../other', 'npm test --prefix ../x', 'npm test --script-shell=sh', 'npm test\nrm x'
    ]) {
      expect(rules.find(workspace, run(command)), command).toBeUndefined()
    }
  })

  it('never honors a rule that was not produced for a safe command', () => {
    // A hand-edited or corrupted store must not turn into broad approval.
    mkdirSync(join(root, 'data'))
    const entry = (tool: string, pattern: string) => ({ id: `${tool}-${pattern}`, workspace, tool, pattern, label: pattern, createdAt: 1 })
    writeFileSync(file(), JSON.stringify({ version: 1, rules: [
      entry('run_command', 'rm'), entry('run_command', 'bash -c'), entry('run_command', '*'), entry('run_command', 'npm'),
      entry('run_command', 'git push'), entry('run_command', 'curl'), entry('remove_file', '*'), entry('read_file', '*')
    ] }))
    const rules = store()
    expect(rules.list()).toHaveLength(8)
    const calls: Call[] = [
      run('rm -rf x'), run('bash -c "x"'), run('npm test'), run('npm install x'), run('git push origin main'), run('curl http://example.com'),
      { name: 'remove_file', input: { path: 'a.ts' } }, { name: 'read_file', input: { path: 'a.ts' } }, { name: 'made_up', input: {} }
    ]
    for (const call of calls) {
      expect(rules.find(workspace, call), JSON.stringify(call)).toBeUndefined()
    }
  })

  it('keeps a damaged file aside and starts empty instead of overwriting it', () => {
    mkdirSync(join(root, 'data'))
    writeFileSync(file(), '{ not json')
    const onError = vi.fn()
    const rules = store({ ...env, onError })
    expect(rules.list()).toEqual([])
    expect(onError).toHaveBeenCalledOnce()
    expect(readdirSync(join(root, 'data')).some((name) => name.startsWith('permission-rules.json.corrupt-'))).toBe(true)
    rules.add(workspace, { tool: 'edit_file', pattern: '*', label: 'Edits' })
    expect(store().list()).toHaveLength(1)
  })
})
