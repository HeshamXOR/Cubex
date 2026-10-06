import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolCall } from '@core/types'
import {
  PermissionRuleStore, commandPattern, parsePermissionDecision, parseRuleId, parseWorkspaceFilter,
  simpleCommandTokens, suggestRule, workspaceKey, type RuleEnvironment, type SuggestContext
} from './permissionRules'

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
  it('splits words and honors double quotes', () => {
    expect(simpleCommandTokens('npm test -- -t "my test"')).toEqual(['npm', 'test', '--', '-t', 'my test'])
    expect(simpleCommandTokens('  npm\ttest   --coverage  ')).toEqual(['npm', 'test', '--coverage'])
  })

  it.each([
    'npm test && echo hi', 'npm test; ls', 'npm test || true', 'npm test | tee out.txt', 'npm test &',
    'npm test > out.txt', 'npm test >> out.txt', 'npm test < in.txt', 'npm test 2>&1',
    'npm test $(whoami)', 'npm test `id`', 'npm test ${HOME}', '(npm test)', 'npm test {a,b}',
    'npm test\nrm -rf x', 'npm test\r\nx', 'echo %PATH%', 'npm test ^& x', 'echo !x', 'npm test\0'
  ])('rejects shell syntax: %j', (command) => {
    expect(simpleCommandTokens(command)).toBeUndefined()
  })

  it('rejects empty, unbalanced, glued and oversized input', () => {
    expect(simpleCommandTokens('')).toBeUndefined()
    expect(simpleCommandTokens('   ')).toBeUndefined()
    expect(simpleCommandTokens('npm test "abc')).toBeUndefined()
    expect(simpleCommandTokens('npm run b"u"ild')).toBeUndefined()
    expect(simpleCommandTokens('npm test --name="a b"')).toBeUndefined()
    expect(simpleCommandTokens('npm test ""')).toBeUndefined()
    expect(simpleCommandTokens(`npm test ${'a'.repeat(3_000)}`)).toBeUndefined()
    expect(simpleCommandTokens('npm test\u00a0x')).toBeUndefined()
  })

  it('allows wildcards only inside quotes, where the shell leaves them alone', () => {
    expect(simpleCommandTokens('pytest tests/*.py')).toBeUndefined()
    expect(simpleCommandTokens('pytest tests/test_?.py')).toBeUndefined()
    expect(simpleCommandTokens('pytest tests/[ab].py')).toBeUndefined()
    expect(simpleCommandTokens('prettier --check "src/**/*.ts"')).toEqual(['prettier', '--check', 'src/**/*.ts'])
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

  it('keeps the script name and requires an exact script on later commands', () => {
    expect(pattern('npm run build')).toBe('npm run build')
    expect(pattern('npm run build:prod')).toBe('npm run build:prod')
    expect(pattern('npm run Build')).toBe('npm run Build')
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

  it('keeps the read-only classifier flag checks for read-only git', () => {
    expect(pattern('git diff --output=changes.patch')).toBeUndefined()
    expect(pattern('git log --ext-diff')).toBeUndefined()
    expect(pattern('git show --textconv HEAD')).toBeUndefined()
  })

  it('needs an absolute workspace', () => {
    expect(commandPattern('npm test', 'relative/dir', env)).toBeUndefined()
    expect(commandPattern('npm test', '', env)).toBeUndefined()
  })
})

describe('suggestRule', () => {
  it('suggests the command pattern for a simple command', () => {
    expect(suggestRule(run('npm test -- --coverage'), context())).toEqual({ tool: 'run_command', pattern: 'npm test', label: 'npm test' })
    expect(suggestRule(run('npm test && rm -rf x'), context())).toBeUndefined()
  })

  it('suggests project-wide edits in default mode only', () => {
    expect(suggestRule({ name: 'edit_file', input: { path: 'a.ts' } }, context())).toEqual({ tool: 'edit_file', pattern: '*', label: 'Edits in my-project' })
    expect(suggestRule({ name: 'write_file', input: { path: 'a.ts' } }, context())).toEqual({ tool: 'write_file', pattern: '*', label: 'Edits in my-project' })
    for (const mode of ['acceptEdits', 'bypass', 'plan'] as const) {
      expect(suggestRule({ name: 'edit_file', input: { path: 'a.ts' } }, context({ mode }))).toBeUndefined()
    }
  })

  it('suggests the host for web_fetch', () => {
    expect(suggestRule({ name: 'web_fetch', input: { url: 'https://Docs.Example.COM:8443/guide?q=1' } }, context()))
      .toEqual({ tool: 'web_fetch', pattern: 'docs.example.com', label: 'docs.example.com' })
    for (const url of ['not a url', 'ftp://example.com/x', 'http://127.0.0.1/admin', 'http://localhost:3000', 'https://user:pass@example.com/']) {
      expect(suggestRule({ name: 'web_fetch', input: { url } }, context())).toBeUndefined()
    }
    expect(suggestRule({ name: 'web_fetch', input: {} }, context())).toBeUndefined()
  })

  it('suggests a tool-wide rule for MCP tools and subagents', () => {
    expect(suggestRule({ name: 'mcp__github__create_issue', input: {} }, context()))
      .toEqual({ tool: 'mcp__github__create_issue', pattern: '*', label: 'create_issue from github' })
    expect(suggestRule({ name: 'delegate_to_subagent', input: { task: 'x' } }, context()))
      .toEqual({ tool: 'delegate_to_subagent', pattern: '*', label: 'Subagents' })
    expect(suggestRule({ name: 'mcp__lonely', input: {} }, context())).toBeUndefined()
  })

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

  it('needs a project to scope to', () => {
    expect(suggestRule(run('npm test'), context({ workspace: undefined }))).toBeUndefined()
    expect(suggestRule(run('npm test'), context({ workspace: 'relative' }))).toBeUndefined()
  })
})

describe('workspaceKey', () => {
  it('normalizes separators and trailing slashes, and folds case on Windows only', () => {
    expect(workspaceKey(`${workspace}/`, 'linux')).toBe(workspaceKey(workspace, 'linux'))
    expect(workspaceKey(workspace.toUpperCase(), 'win32')).toBe(workspaceKey(workspace, 'win32'))
    expect(workspaceKey(workspace.toUpperCase(), 'linux')).not.toBe(workspaceKey(workspace, 'linux'))
    expect(workspaceKey('relative', 'linux')).toBeUndefined()
    expect(workspaceKey('', 'linux')).toBeUndefined()
  })
})

describe('PermissionRuleStore', () => {
  const file = (): string => join(root, 'data', 'permission-rules.json')
  const edit = { name: 'edit_file', input: { path: 'a.ts' } }
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

  it('does not duplicate an identical rule', () => {
    const rules = store()
    const first = rules.add(workspace, { tool: 'run_command', pattern: 'npm test', label: 'npm test' })
    const second = rules.add(`${workspace}${process.platform === 'win32' ? '\\' : '/'}`, { tool: 'run_command', pattern: 'npm test', label: 'npm test' })
    expect(second.id).toBe(first.id)
    expect(rules.list()).toHaveLength(1)
  })

  it('scopes rules to their project and filters listings by workspace', () => {
    const other = join(root, 'other-project')
    mkdirSync(other)
    const rules = store()
    rules.add(workspace, { tool: 'edit_file', pattern: '*', label: 'Edits in my-project' })
    rules.add(other, { tool: 'run_command', pattern: 'npm test', label: 'npm test' })
    expect(rules.list(workspace).map((rule) => rule.tool)).toEqual(['edit_file'])
    expect(rules.list(other).map((rule) => rule.tool)).toEqual(['run_command'])
    expect(rules.list()).toHaveLength(2)
    expect(rules.list('relative')).toEqual([])
    expect(rules.find(workspace, edit)).toBeDefined()
    expect(rules.find(other, edit)).toBeUndefined()
    expect(rules.find(other, run('npm test'))).toBeDefined()
    expect(rules.find(workspace, run('npm test'))).toBeUndefined()
  })

  it('compares workspaces case-insensitively on Windows only', () => {
    const windows = store({ ...env, platform: 'win32' })
    windows.add(workspace, { tool: 'edit_file', pattern: '*', label: 'Edits in my-project' })
    expect(windows.find(workspace.toUpperCase(), edit)).toBeDefined()
    expect(windows.list(workspace.toUpperCase())).toHaveLength(1)
    const linux = store({ ...env, platform: 'linux' })
    expect(linux.find(workspace.toUpperCase(), edit)).toBeUndefined()
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

  it('lets one edit rule cover edit_file and write_file but nothing else', () => {
    const rules = store()
    rules.add(workspace, { tool: 'write_file', pattern: '*', label: 'Edits in my-project' })
    expect(rules.find(workspace, edit)).toBeDefined()
    expect(rules.find(workspace, { name: 'write_file', input: { path: 'b.ts' } })).toBeDefined()
    expect(rules.find(workspace, { name: 'remove_file', input: { path: 'b.ts' } })).toBeUndefined()
    expect(rules.find(workspace, run('npm test'))).toBeUndefined()
  })

  it('matches web_fetch by exact host', () => {
    const rules = store()
    rules.add(workspace, { tool: 'web_fetch', pattern: 'docs.example.com', label: 'docs.example.com' })
    const fetch = (url: string) => rules.find(workspace, { name: 'web_fetch', input: { url } })
    expect(fetch('https://docs.example.com/a/b?c=d')).toBeDefined()
    expect(fetch('https://DOCS.EXAMPLE.COM/')).toBeDefined()
    expect(fetch('https://evil.docs.example.com/')).toBeUndefined()
    expect(fetch('https://example.com/')).toBeUndefined()
    expect(fetch('https://docs.example.com.evil.net/')).toBeUndefined()
    expect(fetch('not a url')).toBeUndefined()
  })

  it('matches MCP tools and subagents by exact tool name', () => {
    const rules = store()
    rules.add(workspace, { tool: 'mcp__github__create_issue', pattern: '*', label: 'create_issue from github' })
    rules.add(workspace, { tool: 'delegate_to_subagent', pattern: '*', label: 'Subagents' })
    expect(rules.find(workspace, { name: 'mcp__github__create_issue', input: { title: 'x' } })).toBeDefined()
    expect(rules.find(workspace, { name: 'mcp__github__delete_repo', input: {} })).toBeUndefined()
    expect(rules.find(workspace, { name: 'mcp__gitlab__create_issue', input: {} })).toBeUndefined()
    expect(rules.find(workspace, { name: 'delegate_to_subagent', input: { task: 'x' } })).toBeDefined()
  })

  it('drops malformed entries but keeps the valid ones', () => {
    mkdirSync(join(root, 'data'))
    const good = { id: 'ok', workspace, tool: 'edit_file', pattern: '*', label: 'Edits', createdAt: 5 }
    writeFileSync(file(), JSON.stringify({ rules: [
      good, null, 'x', { ...good, id: '' }, { ...good, workspace: 'relative' }, { ...good, tool: 'bad tool!' },
      { ...good, pattern: '' }, { ...good, createdAt: 'yesterday' }, { ...good, id: 'x'.repeat(200) }
    ] }))
    expect(store().list().map((rule) => rule.id)).toEqual(['ok'])
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

  it('treats a missing file as empty and creates the folder on first save', () => {
    expect(existsSync(join(root, 'data'))).toBe(false)
    const rules = store()
    expect(rules.list()).toEqual([])
    rules.add(workspace, { tool: 'edit_file', pattern: '*', label: 'Edits' })
    expect(existsSync(file())).toBe(true)
  })

  it('validates what it saves', () => {
    const rules = store()
    expect(() => rules.add('relative', { tool: 'edit_file', pattern: '*', label: 'x' })).toThrow('absolute')
    expect(() => rules.add(workspace, { tool: 'bad tool', pattern: '*', label: 'x' })).toThrow('Invalid permission rule')
    expect(() => rules.add(workspace, { tool: 'edit_file', pattern: '', label: 'x' })).toThrow('Invalid permission rule')
    expect(rules.list()).toEqual([])
  })

  it('returns copies so callers cannot edit saved rules', () => {
    const rules = store()
    rules.add(workspace, { tool: 'edit_file', pattern: '*', label: 'Edits' })
    rules.list()[0]!.pattern = 'rm'
    expect(rules.list()[0]!.pattern).toBe('*')
  })
})

describe('IPC input validation', () => {
  it('accepts exactly the three decisions', () => {
    for (const decision of ['allow', 'deny', 'always'] as const) expect(parsePermissionDecision(decision)).toBe(decision)
    for (const bad of ['yes', 'ALLOW', '', undefined, null, 1, {}, ['allow']]) expect(() => parsePermissionDecision(bad)).toThrow('Invalid permission decision')
  })

  it('bounds ids and the workspace filter', () => {
    expect(parseRuleId('abc')).toBe('abc')
    for (const bad of ['', '   ', 'x'.repeat(129), undefined, 5, {}]) expect(() => parseRuleId(bad)).toThrow('Invalid id')
    expect(() => parseRuleId('', 'rule id')).toThrow('Invalid rule id')
    expect(parseWorkspaceFilter(undefined)).toBeUndefined()
    expect(parseWorkspaceFilter(null)).toBeUndefined()
    expect(parseWorkspaceFilter(workspace)).toBe(workspace)
    for (const bad of ['', 42, 'x'.repeat(5_000), {}]) expect(() => parseWorkspaceFilter(bad)).toThrow('Invalid workspace')
  })
})
