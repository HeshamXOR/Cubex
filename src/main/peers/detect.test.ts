import { describe, expect, it } from 'vitest'
import { KNOWN_AGENTS, type KnownAgent } from '@shared/agentCatalog'
import { detectAgents, parseClaudeStatus, parseCodexStatus, parseVersion, runProbe, type ProbeResult, type ProbeRunner } from './detect'
import type { AppProgram } from './appPrograms'

const ok = (stdout: string, extra: Partial<ProbeResult> = {}): ProbeResult => ({ code: 0, stdout, stderr: '', timedOut: false, ...extra })

describe('parseVersion', () => {
  it('reads the number out of what programs print', () => {
    expect(parseVersion('2.1.4 (Claude Code)')).toBe('2.1.4')
    expect(parseVersion('codex-cli 0.46.0\n')).toBe('0.46.0')
    expect(parseVersion('opencode v1.18.35')).toBe('1.18.35')
    expect(parseVersion('GitHub Copilot CLI 1.0.95.')).toBe('1.0.95')
    expect(parseVersion('\u001b[1m0.63.0\u001b[0m')).toBe('0.63.0')
    expect(parseVersion('1.2.3-beta.1 (build 5)')).toBe('1.2.3-beta.1')
  })

  it('says nothing when there is no number', () => {
    expect(parseVersion('')).toBeUndefined()
    expect(parseVersion('usage: claude [options]')).toBeUndefined()
  })
})

describe('parseClaudeStatus', () => {
  it('reads a subscription login with its account', () => {
    expect(parseClaudeStatus('{"loggedIn":true,"authMethod":"claude.ai","account":{"email":"a@example.com"}}\n')).toEqual({ state: 'signed-in', label: 'a Claude subscription', email: 'a@example.com' })
  })

  it('names the plan when the program says which', () => {
    expect(parseClaudeStatus('{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}')).toEqual({ state: 'signed-in', label: 'Claude Max' })
    expect(parseClaudeStatus('{"loggedIn":true,"authMethod":"claude.ai","account":{"subscriptionType":"claude_pro_subscription"}}')).toMatchObject({ label: 'Claude Pro' })
  })

  it('tells an API key from a subscription', () => {
    expect(parseClaudeStatus('{"loggedIn":true,"authMethod":"api-key"}')).toEqual({ state: 'signed-in', label: 'an Anthropic API key' })
  })

  it('reads a signed-out program', () => {
    expect(parseClaudeStatus('{"loggedIn":false}\n')).toEqual({ state: 'signed-out' })
  })

  it('finds the object when text surrounds it', () => {
    expect(parseClaudeStatus('Checking...\n{"loggedIn":true,"authMethod":"claude.ai"}\nDone')).toMatchObject({ state: 'signed-in' })
  })

  it('does not call a program signed out because it printed something else', () => {
    expect(parseClaudeStatus('')).toEqual({ state: 'unknown' })
    expect(parseClaudeStatus('error: unknown command "auth"')).toEqual({ state: 'unknown' })
    expect(parseClaudeStatus('{"loggedIn":"yes"}')).toEqual({ state: 'unknown' })
    expect(parseClaudeStatus('{not json}')).toEqual({ state: 'unknown' })
  })

  it('never keeps more than a short method name from a method it does not know', () => {
    const account = parseClaudeStatus(`{"loggedIn":true,"authMethod":"${'x'.repeat(200)}"}`)
    expect(account.label?.length).toBeLessThanOrEqual(40)
  })
})

describe('parseCodexStatus', () => {
  it('reads a ChatGPT login', () => {
    expect(parseCodexStatus('Logged in using ChatGPT\n')).toEqual({ state: 'signed-in', label: 'ChatGPT' })
  })

  it('reads an API key login and never shows the key', () => {
    const account = parseCodexStatus('Logged in using an API key - sk-proj-abcdefghijklmnopqrstuvwxyz123456')
    expect(account).toEqual({ state: 'signed-in', label: 'an OpenAI API key' })
  })

  it('reads a signed-out program', () => {
    expect(parseCodexStatus('Not logged in')).toEqual({ state: 'signed-out' })
  })

  it('does not call a program signed out because it printed something else', () => {
    expect(parseCodexStatus('error: unrecognized subcommand \'status\'')).toEqual({ state: 'unknown' })
    expect(parseCodexStatus('')).toEqual({ state: 'unknown' })
  })

  it('ignores colour codes', () => {
    expect(parseCodexStatus('\u001b[32mLogged in using ChatGPT\u001b[0m')).toMatchObject({ state: 'signed-in', label: 'ChatGPT' })
  })
})

/** A small catalog and a computer where only these programs exist, answering as scripted. */
const claude: KnownAgent = { id: 'claude-code', name: 'Claude Code', vendor: 'Anthropic', programs: ['claude'], account: 'claude', signIn: ['auth', 'login'], installUrl: 'https://example.com', connection: { kind: 'acp', preset: 'claude' } }
const codex: KnownAgent = { id: 'codex', name: 'Codex', vendor: 'OpenAI', programs: ['codex'], account: 'codex', installUrl: 'https://example.com', connection: { kind: 'acp', preset: 'codex' } }
const gemini: KnownAgent = { id: 'gemini', name: 'Gemini', vendor: 'Google', programs: ['gemini-cli', 'gemini'], installUrl: 'https://example.com', connection: { kind: 'acp', preset: 'gemini' } }

function computer(files: Record<string, string>, answers: Record<string, ProbeResult | ((args: readonly string[]) => ProbeResult)>, apps: Record<string, AppProgram> = {}) {
  const calls: Array<{ file: string; args: readonly string[] }> = []
  const run: ProbeRunner = async (file, args) => {
    calls.push({ file, args })
    const answer = answers[file]
    if (!answer) return { code: 1, stdout: '', stderr: 'not scripted', timedOut: false }
    return typeof answer === 'function' ? answer(args) : answer
  }
  const locate = (command: string): string | undefined => files[command]
  // What an app that brings a program keeps: nothing, unless the test says so, so the computer running the tests does not matter.
  const app = (command: string): AppProgram | undefined => apps[command]
  return { run, locate, app, calls }
}

describe('detectAgents', () => {
  it('reports a program that is not installed, without starting anything', async () => {
    const pc = computer({}, {})
    const result = await detectAgents({ localOnly: false, run: pc.run, locate: pc.locate, app: pc.app, catalog: [claude, codex], env: {} })
    expect(result.agents).toEqual([
      { id: 'claude-code', found: false, account: { state: 'unknown' }, probed: false },
      { id: 'codex', found: false, account: { state: 'unknown' }, probed: false }
    ])
    expect(pc.calls).toEqual([])
    expect(result.node).toEqual({ found: false })
  })

  it('finds the program, its version and who it is signed in as', async () => {
    const pc = computer({ claude: 'C:\\bin\\claude.exe', codex: 'C:\\bin\\codex.exe' }, {
      'C:\\bin\\claude.exe': (args) => (args[0] === '--version' ? ok('2.1.4 (Claude Code)') : ok('{"loggedIn":true,"authMethod":"claude.ai","account":{"email":"me@example.com"}}')),
      'C:\\bin\\codex.exe': (args) => (args[0] === '--version' ? ok('codex-cli 0.46.0') : ok('Logged in using ChatGPT'))
    })
    const result = await detectAgents({ localOnly: false, run: pc.run, locate: pc.locate, app: pc.app, catalog: [claude, codex], env: {} })
    expect(result.agents[0]).toEqual({ id: 'claude-code', found: true, path: 'C:\\bin\\claude.exe', version: '2.1.4', account: { state: 'signed-in', label: 'a Claude subscription', email: 'me@example.com' }, probed: true })
    expect(result.agents[1]).toEqual({ id: 'codex', found: true, path: 'C:\\bin\\codex.exe', version: '0.46.0', account: { state: 'signed-in', label: 'ChatGPT' }, probed: true })
    expect(pc.calls.map((call) => call.args.join(' '))).toEqual(expect.arrayContaining(['--version', 'auth status', 'login status']))
  })

  it('asks only the programs that have a command for it who they are signed in as', async () => {
    const pc = computer({ gemini: 'C:\\bin\\gemini.exe' }, { 'C:\\bin\\gemini.exe': ok('0.63.0') })
    const result = await detectAgents({ localOnly: false, run: pc.run, locate: pc.locate, app: pc.app, catalog: [gemini], env: {} })
    expect(result.agents[0]).toMatchObject({ found: true, version: '0.63.0', account: { state: 'unknown' }, probed: true })
    expect(pc.calls).toHaveLength(1)
  })

  it('takes the first program name that exists', async () => {
    const pc = computer({ 'gemini-cli': 'C:\\bin\\first.exe', gemini: 'C:\\bin\\second.exe' }, { 'C:\\bin\\first.exe': ok('1.0.0') })
    const result = await detectAgents({ localOnly: false, run: pc.run, locate: pc.locate, app: pc.app, catalog: [gemini], env: {} })
    expect(result.agents[0]?.path).toBe('C:\\bin\\first.exe')
  })

  it('only looks in local-only mode: the program is found and not started', async () => {
    const pc = computer({ claude: 'C:\\bin\\claude.exe', npx: 'C:\\bin\\npx.cmd', node: 'C:\\bin\\node.exe' }, {})
    const result = await detectAgents({ localOnly: true, run: pc.run, locate: pc.locate, app: pc.app, catalog: [claude], env: {} })
    expect(result.agents[0]).toEqual({ id: 'claude-code', found: true, path: 'C:\\bin\\claude.exe', account: { state: 'unknown' }, probed: false })
    expect(result.localOnly).toBe(true)
    expect(result.node).toEqual({ found: true })
    expect(pc.calls).toEqual([])
  })

  it('says a program that is there but does not run did not run, with why', async () => {
    const pc = computer({ claude: 'C:\\bin\\claude.exe' }, { 'C:\\bin\\claude.exe': { code: 1, stdout: '', stderr: 'Error: Cannot find module "x"', timedOut: false } })
    const result = await detectAgents({ localOnly: false, run: pc.run, locate: pc.locate, app: pc.app, catalog: [claude], env: {} })
    expect(result.agents[0]).toMatchObject({ found: true, probed: false, account: { state: 'unknown' } })
    expect(result.agents[0]?.problem).toContain('did not run')
    expect(result.agents[0]?.problem).toContain('Cannot find module')
    // It is not asked who it is signed in as when it cannot say its version.
    expect(pc.calls).toHaveLength(1)
  })

  it('says a program that takes too long did not answer in time', async () => {
    const pc = computer({ claude: 'C:\\bin\\claude.exe' }, { 'C:\\bin\\claude.exe': { code: null, stdout: '', stderr: '', timedOut: true } })
    const result = await detectAgents({ localOnly: false, run: pc.run, locate: pc.locate, app: pc.app, catalog: [claude], env: {} })
    expect(result.agents[0]?.problem).toContain('did not answer within a few seconds')
  })

  it('accepts a program that exits with an error but prints its version', async () => {
    const pc = computer({ gemini: 'C:\\bin\\gemini.exe' }, { 'C:\\bin\\gemini.exe': { code: 2, stdout: '0.63.0', stderr: '', timedOut: false } })
    const result = await detectAgents({ localOnly: false, run: pc.run, locate: pc.locate, app: pc.app, catalog: [gemini], env: {} })
    expect(result.agents[0]).toMatchObject({ probed: true, version: '0.63.0' })
  })

  it('keeps the version when the account check fails or times out', async () => {
    const pc = computer({ claude: 'C:\\bin\\claude.exe' }, {
      'C:\\bin\\claude.exe': (args) => (args[0] === '--version' ? ok('2.1.4') : { code: null, stdout: '', stderr: '', timedOut: true })
    })
    const result = await detectAgents({ localOnly: false, run: pc.run, locate: pc.locate, app: pc.app, catalog: [claude], env: {} })
    expect(result.agents[0]).toMatchObject({ version: '2.1.4', probed: true, account: { state: 'unknown' } })
  })

  it('reports a signed-out program as signed out', async () => {
    const pc = computer({ claude: 'C:\\bin\\claude.exe' }, {
      'C:\\bin\\claude.exe': (args) => (args[0] === '--version' ? ok('2.1.4') : { code: 1, stdout: '{"loggedIn":false}', stderr: '', timedOut: false })
    })
    const result = await detectAgents({ localOnly: false, run: pc.run, locate: pc.locate, app: pc.app, catalog: [claude], env: {} })
    expect(result.agents[0]?.account).toEqual({ state: 'signed-out' })
  })

  it('looks for npx, and for its version when it is there', async () => {
    const pc = computer({ npx: 'C:\\node\\npx.cmd', node: 'C:\\node\\node.exe' }, { 'C:\\node\\node.exe': ok('v22.11.0') })
    const result = await detectAgents({ localOnly: false, run: pc.run, locate: pc.locate, app: pc.app, catalog: [], env: {} })
    expect(result.node).toEqual({ found: true, version: '22.11.0' })
  })

  it('starts no more than four programs at once', async () => {
    let live = 0
    let peak = 0
    const catalog: KnownAgent[] = Array.from({ length: 9 }, (_, index) => ({ ...gemini, id: `a${index}`, programs: [`p${index}`] }))
    const run: ProbeRunner = async () => {
      live++
      peak = Math.max(peak, live)
      await new Promise((done) => setTimeout(done, 5))
      live--
      return ok('1.0.0')
    }
    const result = await detectAgents({ localOnly: false, run, locate: (command) => `C:\\bin\\${command}.exe`, app: () => undefined, catalog, env: {} })
    expect(result.agents).toHaveLength(9)
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)
  })

  it('knows the agents it is meant to know', () => {
    expect(KNOWN_AGENTS.map((entry) => entry.id)).toEqual(['claude-code', 'codex', 'gemini', 'opencode', 'cursor', 'copilot', 'goose', 'qwen', 'antigravity'])
  })
})

describe('a program that an app brings', () => {
  const app = (path: string, version?: string): AppProgram => ({ path, app: 'the Claude desktop app', ...(version ? { version } : {}) })

  it('is found in the app\'s folder when PATH has none, and says where', async () => {
    const path = 'C:\\Users\\Ada\\AppData\\Roaming\\Claude\\claude-code\\2.1.181\\claude.exe'
    const pc = computer({}, {
      [path]: (args) => (args[0] === '--version' ? ok('2.1.181 (Claude Code)') : ok('{"loggedIn":false}'))
    }, { claude: app(path, '2.1.181') })
    const result = await detectAgents({ localOnly: false, run: pc.run, locate: pc.locate, app: pc.app, catalog: [claude], env: {} })
    expect(result.agents[0]).toEqual({ id: 'claude-code', found: true, path, via: 'the Claude desktop app', version: '2.1.181', account: { state: 'signed-out' }, probed: true })
  })

  it('is not looked for in an app when PATH has the program', async () => {
    const asked: string[] = []
    const pc = computer({ claude: 'C:\\bin\\claude.exe' }, { 'C:\\bin\\claude.exe': ok('2.1.4') })
    const result = await detectAgents({ localOnly: false, run: pc.run, locate: pc.locate, app: (command) => { asked.push(command); return undefined }, catalog: [claude], env: {} })
    expect(asked).toEqual([])
    expect(result.agents[0]?.via).toBeUndefined()
  })

  it('takes its version from the folder when the program does not say it, and from the program when it does', async () => {
    const path = 'C:\\apps\\claude.exe'
    const silent = computer({}, { [path]: { code: 0, stdout: 'Claude Code', stderr: '', timedOut: false } }, { claude: app(path, '2.1.289') })
    expect((await detectAgents({ localOnly: false, run: silent.run, locate: silent.locate, app: silent.app, catalog: [claude], env: {} })).agents[0]?.version).toBe('2.1.289')
    const says = computer({}, { [path]: ok('2.1.293') }, { claude: app(path, '2.1.289') })
    expect((await detectAgents({ localOnly: false, run: says.run, locate: says.locate, app: says.app, catalog: [claude], env: {} })).agents[0]?.version).toBe('2.1.293')
  })

  it('is found and not started in local-only mode', async () => {
    const path = 'C:\\apps\\claude.exe'
    const pc = computer({}, {}, { claude: app(path, '2.1.289') })
    const result = await detectAgents({ localOnly: true, run: pc.run, locate: pc.locate, app: pc.app, catalog: [claude], env: {} })
    expect(result.agents[0]).toEqual({ id: 'claude-code', found: true, path, via: 'the Claude desktop app', version: '2.1.289', account: { state: 'unknown' }, probed: false })
    expect(pc.calls).toEqual([])
  })

  it('says where it was found when it does not run', async () => {
    const path = 'C:\\apps\\claude.exe'
    const pc = computer({}, { [path]: { code: 1, stdout: '', stderr: 'Error: broken install', timedOut: false } }, { claude: app(path) })
    const result = await detectAgents({ localOnly: false, run: pc.run, locate: pc.locate, app: pc.app, catalog: [claude], env: {} })
    expect(result.agents[0]).toMatchObject({ found: true, via: 'the Claude desktop app', probed: false })
    expect(result.agents[0]?.problem).toContain('did not run')
  })
})

describe('runProbe', () => {
  const env = { ...process.env }

  it('runs a program and returns what it printed', async () => {
    const result = await runProbe(process.execPath, ['-e', 'console.log("hello 1.2.3"); console.error("warn")'], { env, cwd: process.cwd(), timeoutMs: 20_000 })
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('hello 1.2.3')
    expect(result.stderr.trim()).toBe('warn')
    expect(result.timedOut).toBe(false)
  })

  it('returns the exit code of a program that fails', async () => {
    const result = await runProbe(process.execPath, ['-e', 'process.exit(3)'], { env, cwd: process.cwd(), timeoutMs: 20_000 })
    expect(result.code).toBe(3)
  })

  it('stops a program that takes too long and says so', async () => {
    const started = Date.now()
    const result = await runProbe(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env, cwd: process.cwd(), timeoutMs: 400 })
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(15_000)
  })

  it('says a program that cannot be started could not be started', async () => {
    const result = await runProbe('Z:\\definitely\\missing\\program.exe', [], { env, cwd: process.cwd(), timeoutMs: 2_000 })
    expect(result.code).toBeNull()
    expect(result.error).toBeTruthy()
  })

  it('keeps no more than a bounded amount of output', async () => {
    const result = await runProbe(process.execPath, ['-e', 'process.stdout.write("x".repeat(200000))'], { env, cwd: process.cwd(), timeoutMs: 20_000 })
    expect(result.stdout.length).toBeLessThanOrEqual(16_000)
  })
})

describe('the catalog', () => {
  it('has a connection for every program, and a sign-in command only where the vendor documents one', () => {
    for (const entry of KNOWN_AGENTS) {
      expect(entry.programs.length).toBeGreaterThan(0)
      expect(entry.installUrl).toMatch(/^https:\/\//)
    }
    const withCommand = KNOWN_AGENTS.filter((entry) => entry.signIn).map((entry) => entry.id)
    expect(withCommand).toEqual(['claude-code', 'codex', 'opencode', 'cursor'])
  })
})
