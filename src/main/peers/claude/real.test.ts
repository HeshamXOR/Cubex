import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AcpPeer } from '@shared/peers'
import { removeFolder } from '../../testing/removeFolder'
import { AcpAgent, AcpFailure, type OpenOptions } from '../acp/agent'
import { createDelegatePolicy, type DelegateQuestion } from '../acp/delegatePolicy'
import { findAppProgram } from '../appPrograms'
import { locatePeer } from '../peerRunner'
import { startAnthropicMock, type MockApi, type MockBlock } from './testing/anthropicMock'

/**
 * The bridge against the real Claude Code, when this computer has one: on PATH, or in the Claude desktop app. The model is a
 * scripted stand-in (testing/anthropicMock.ts) that Claude Code is pointed at, so no account is used and nothing leaves this
 * computer. What this proves is what the stand-in program cannot: that the options Cubex starts Claude Code with are ones it
 * accepts, that its questions and answers are the shape it speaks, and that the rules Cubex gives it hold against a person's own
 * settings. Set CUBEX_SKIP_REAL_CLAUDE=1 to leave it out, or CUBEX_TEST_CLAUDE to the path of the program to try.
 */

const program = process.env.CUBEX_SKIP_REAL_CLAUDE === '1' ? undefined : (process.env.CUBEX_TEST_CLAUDE || locatePeer({ command: 'claude' }) || findAppProgram('claude')?.path)

describe.skipIf(!program)('the real Claude Code', () => {
  let dir: string
  let config: string
  let api: MockApi | undefined
  const agents: AcpAgent[] = []

  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cubex-claude-real-')))
    config = join(dir, '.config')
    mkdirSync(config)
    mkdirSync(join(dir, 'project'))
    writeFileSync(join(dir, 'project', 'notes.txt'), 'the notes say hello\n')
  })
  afterEach(async () => {
    for (const agent of agents.splice(0)) agent.kill(true)
    await api?.close()
    api = undefined
    await removeFolder(dir)
  })

  const project = (...parts: string[]): string => join(dir, 'project', ...parts)
  const peer = (over: Partial<AcpPeer> = {}): AcpPeer => ({ kind: 'acp', id: 'claude', name: 'Claude Code', enabled: true, preset: 'claude-direct', command: program!, args: [], passEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'], ...over })

  async function open(script: MockBlock[][], options: Partial<OpenOptions> = {}, signedIn = true): Promise<AcpAgent> {
    api = await startAnthropicMock(script)
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: config, DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ANTHROPIC_BASE_URL: api.url }
    if (signedIn) env.ANTHROPIC_API_KEY = 'sk-ant-api03-mockmockmockmockmockmockmockmockmockmock'
    else delete env.ANTHROPIC_API_KEY
    const agent = await AcpAgent.open({ peer: peer(), cwd: project(), env, ...options })
    agents.push(agent)
    return agent
  }

  const taskPolicy = (ask: (question: DelegateQuestion) => Promise<boolean>) => createDelegatePolicy({
    root: project(), agent: 'Claude Code', mode: () => 'default', readOnly: false, ask, beforeChange: () => undefined, isProtected: () => false, isReadOnlyCommand: () => false
  })
  const sawInRequests = (text: string): boolean => JSON.stringify(api!.requests).includes(text)
  const hook = (marker: string): Record<string, unknown> => {
    const script = join(dir, 'hook.cjs')
    writeFileSync(script, "require('node:fs').appendFileSync(process.argv[2], 'ran\\n')\n")
    const command = `node "${script.replace(/\\/g, '/')}" "${marker.replace(/\\/g, '/')}"`
    return { hooks: { SessionStart: [{ hooks: [{ type: 'command', command }] }], PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }] } }
  }

  it('answers a consultation, started with the options Cubex gives it', async () => {
    const agent = await open([[{ text: 'pong' }]])
    expect((await agent.prompt('ping')).text).toBe('pong')
    expect(sawInRequests('ping')).toBe(true)
  }, 60_000)

  it('keeps the same conversation for the next message', async () => {
    const agent = await open([[{ text: 'one' }], [{ text: 'two' }]])
    expect((await agent.prompt('first question')).text).toBe('one')
    expect((await agent.prompt('second question')).text).toBe('two')
    expect(api!.requests).toHaveLength(2)
    expect(JSON.stringify(api!.requests[1]!.messages)).toContain('first question')
  }, 60_000)

  it('reads a file in the project, and has no tool to write one with', async () => {
    const agent = await open([
      [{ text: 'Looking.' }, { tool: 'Read', input: { file_path: project('notes.txt') } }],
      [{ tool: 'Write', input: { file_path: project('out.txt'), content: 'written' } }],
      [{ text: 'I could not write it.' }]
    ])
    const steps: string[] = []
    const reply = await agent.prompt('read the notes and write out.txt', { onEvent: (event) => steps.push(`${event.kind}:${event.state}`) })
    expect(reply.text).toContain('I could not write it.')
    expect(existsSync(project('out.txt'))).toBe(false)
    expect(sawInRequests('the notes say hello')).toBe(true)
    expect(sawInRequests('No such tool available')).toBe(true)
    expect(steps).toContain('read:done')
    expect(steps).toContain('edit:failed')
  }, 60_000)

  it('does not offer a consultation the tools that change things', async () => {
    const agent = await open([[{ tool: 'PowerShell', input: { command: 'echo hi' } }], [{ tool: 'Bash', input: { command: 'echo hi' } }], [{ text: 'no tools' }]])
    expect((await agent.prompt('run something')).text).toContain('no tools')
    expect(sawInRequests('No such tool available')).toBe(true)
  }, 60_000)

  it('does a task\'s change when the person agrees, and shows them the change first', async () => {
    const questions: DelegateQuestion[] = []
    const agent = await open(
      [[{ tool: 'Write', input: { file_path: project('out.txt'), content: 'written by the task\n' } }], [{ text: 'Done.' }]],
      { policy: taskPolicy(async (question) => { questions.push(question); return true }) }
    )
    await agent.prompt('write out.txt')
    expect(readFileSync(project('out.txt'), 'utf8')).toBe('written by the task\n')
    expect(questions).toHaveLength(1)
    expect(questions[0]).toMatchObject({ action: 'edit', target: 'out.txt' })
    expect(questions[0]!.detail).toContain('+written by the task')
  }, 60_000)

  it('does not do it when the person says no', async () => {
    const agent = await open(
      [[{ tool: 'Write', input: { file_path: project('out.txt'), content: 'x' } }], [{ text: 'Understood.' }]],
      { policy: taskPolicy(async () => false) }
    )
    await agent.prompt('write out.txt')
    expect(existsSync(project('out.txt'))).toBe(false)
    // Claude Code is told, in words it can act on.
    expect(sawInRequests('Cubex did not allow this')).toBe(true)
  }, 60_000)

  it('does not let a person\'s own "always allow" and hooks make it do something without asking', async () => {
    const marker = join(dir, 'hook-marker.txt')
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ permissions: { allow: ['Write', 'Edit', 'Read', 'PowerShell', 'Bash'], defaultMode: 'bypassPermissions' }, ...hook(marker) }))
    const questions: DelegateQuestion[] = []
    const agent = await open(
      [[{ tool: 'Write', input: { file_path: project('out.txt'), content: 'x' } }], [{ text: 'Done.' }]],
      { policy: taskPolicy(async (question) => { questions.push(question); return false }) }
    )
    await agent.prompt('write out.txt')
    expect(questions).toHaveLength(1)
    expect(existsSync(project('out.txt'))).toBe(false)
    expect(existsSync(marker)).toBe(false)
  }, 60_000)

  it('does not run the hooks of the project it works in', async () => {
    const marker = join(dir, 'project-hook-marker.txt')
    mkdirSync(project('.claude'))
    writeFileSync(project('.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Write'] }, ...hook(marker) }))
    const questions: DelegateQuestion[] = []
    const agent = await open(
      [[{ tool: 'Write', input: { file_path: project('out.txt'), content: 'x' } }], [{ text: 'Done.' }]],
      { policy: taskPolicy(async (question) => { questions.push(question); return false }) }
    )
    await agent.prompt('write out.txt')
    expect(questions).toHaveLength(1)
    expect(existsSync(marker)).toBe(false)
  }, 60_000)

  it('says to sign in, with how, when Claude Code has no login', async () => {
    const error = await open([[{ text: 'never' }]], {}, false).then(() => undefined, (caught: unknown) => caught)
    expect(error).toBeInstanceOf(AcpFailure)
    expect((error as AcpFailure).message).toBe('Claude Code is not signed in.')
    expect((error as AcpFailure).hint).toContain('Sign in')
  }, 60_000)
})
