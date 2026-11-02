import { describe, expect, it } from 'vitest'
import { type KnownAgent } from '@shared/agentCatalog'
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
})

describe('parseClaudeStatus', () => {
  it('reads a subscription login with its account', () => {
    expect(parseClaudeStatus('{"loggedIn":true,"authMethod":"claude.ai","account":{"email":"a@example.com"}}\n')).toEqual({ state: 'signed-in', label: 'a Claude subscription', email: 'a@example.com' })
  })

  it('reads a signed-out program', () => {
    expect(parseClaudeStatus('{"loggedIn":false}\n')).toEqual({ state: 'signed-out' })
  })

  it('does not call a program signed out because it printed something else', () => {
    expect(parseClaudeStatus('')).toEqual({ state: 'unknown' })
    expect(parseClaudeStatus('error: unknown command "auth"')).toEqual({ state: 'unknown' })
    expect(parseClaudeStatus('{"loggedIn":"yes"}')).toEqual({ state: 'unknown' })
    expect(parseClaudeStatus('{not json}')).toEqual({ state: 'unknown' })
  })
})

describe('parseCodexStatus', () => {

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
})

describe('runProbe', () => {
  const env = { ...process.env }

  it('stops a program that takes too long and says so', async () => {
    const started = Date.now()
    const result = await runProbe(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env, cwd: process.cwd(), timeoutMs: 400 })
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(15_000)
  })
})
