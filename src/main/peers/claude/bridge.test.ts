import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AcpPeer } from '@shared/peers'
import type { LaunchInput, LaunchPlan } from '../../mcp/resolveLaunch'
import { LaunchError } from '../../mcp/resolveLaunch'
import { removeFolder } from '../../testing/removeFolder'
import { AcpAgent, AcpFailure, type AcpEvent, type OpenOptions } from '../acp/agent'
import { createDelegatePolicy, type DelegateQuestion } from '../acp/delegatePolicy'

// A real program, started the way Claude Code is: a scripted stand-in that speaks its stream-json protocol (testing/mockClaude.cjs).
const MOCK = fileURLToPath(new URL('./testing/mockClaude.cjs', import.meta.url))
let dir: string
let recordPath: string
let counter = 0
const agents: AcpAgent[] = []

beforeAll(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cubex-claude-bridge-')))
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1\n')
})
afterAll(() => removeFolder(dir))
beforeEach(() => { recordPath = join(dir, `record-${++counter}.jsonl`) })
afterEach(() => { for (const agent of agents.splice(0)) agent.kill(true) })

const launch = ({ args }: LaunchInput): LaunchPlan => ({ file: process.execPath, args: [MOCK, ...(args ?? [])], windowsVerbatimArguments: false, mode: 'direct' })
const peer = (over: Partial<AcpPeer> = {}): AcpPeer => ({ kind: 'acp', id: 'claude', name: 'Claude Code', enabled: true, preset: 'claude-direct', command: 'claude', args: [], ...over })

async function open(env: Record<string, string> = {}, options: Partial<OpenOptions> = {}, over: Partial<AcpPeer> = {}): Promise<AcpAgent> {
  const agent = await AcpAgent.open({ peer: peer(over), cwd: dir, env: { ...process.env, MOCK_RECORD: recordPath, ...env }, launch, ...options })
  agents.push(agent)
  return agent
}

interface Entry { started?: { argv: string[]; cwd: string; env: Record<string, string | null> }; received?: Record<string, unknown> }
const recorded = (): Entry[] => {
  try { return readFileSync(recordPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Entry) } catch { return [] }
}
const started = (): NonNullable<Entry['started']> => recorded().find((entry) => entry.started)!.started!
const argAfter = (flag: string): string => { const argv = started().argv; return argv[argv.indexOf(flag) + 1]! }
/** What the bridge answered Claude Code's questions with, in order. */
const answers = (): Array<{ behavior: string; message?: string; updatedInput?: unknown }> => recorded()
  .map((entry) => entry.received)
  .filter((message): message is Record<string, unknown> => message?.type === 'control_response')
  .map((message) => (message.response as { response: { behavior: string; message?: string; updatedInput?: unknown } }).response)
  .filter((response) => response?.behavior !== undefined)
const failure = async (work: Promise<unknown>): Promise<AcpFailure> => {
  const error = await work.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(AcpFailure)
  return error as AcpFailure
}
const waitFor = async (condition: () => boolean, ms = 3_000): Promise<void> => {
  const end = Date.now() + ms
  while (!condition() && Date.now() < end) await new Promise((done) => setTimeout(done, 20))
  expect(condition()).toBe(true)
}
const read = (path = 'src/a.ts'): string => `@claude tool Read ${JSON.stringify({ file_path: join(dir, path) })}`
const write = (path: string, content: string): string => `@claude tool Write ${JSON.stringify({ file_path: join(dir, path), content })}`

describe('starting Claude Code', () => {
  it('starts it in the folder, in its stream-json mode, with the rules it is held to', async () => {
    const agent = await open()
    const { argv, cwd } = started()
    expect(realpathSync.native(cwd)).toBe(dir)
    expect(argv).toEqual(expect.arrayContaining(['--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio', '--permission-mode', 'default', '--strict-mcp-config', '--no-session-persistence']))
    expect(argAfter('--setting-sources')).toBe('user')
    expect(argAfter('--tools')).toBe('Read,Grep,Glob,LS')
    const rules = argAfter('--settings')
    expect(JSON.parse(readFileSync(rules, 'utf8'))).toMatchObject({ disableAllHooks: true, permissions: { defaultMode: 'default' } })
    await agent.close()
    // The file is removed when the session ends.
    await waitFor(() => !existsSync(rules))
  })

  it('gives a task the tools that change things, and a consultation only the ones that read', async () => {
    const policy = createDelegatePolicy({ root: dir, agent: 'Claude Code', mode: () => 'default', readOnly: false, ask: async () => true, beforeChange: () => undefined, isProtected: () => false, isReadOnlyCommand: () => false })
    await open({}, { policy })
    expect(argAfter('--tools').split(',')).toEqual(expect.arrayContaining(['Read', 'Edit', 'Write', 'Bash', 'PowerShell', 'WebFetch']))
    const reading = createDelegatePolicy({ root: dir, agent: 'Claude Code', mode: () => 'default', readOnly: true, ask: async () => true, beforeChange: () => undefined, isProtected: () => false, isReadOnlyCommand: () => false })
    recordPath = join(dir, `record-again-${counter}.jsonl`)
    await open({}, { policy: reading })
    expect(argAfter('--tools')).toBe('Read,Grep,Glob,LS')
  })

  it('keeps Cubex\'s own keys from it unless they are passed, turns self-update off, and leaves out a host\'s markers', async () => {
    await open({ ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-test', PLAIN: 'yes', CLAUDECODE: '1', CLAUDE_CODE_SSE_PORT: '4242' })
    expect(started().env).toMatchObject({ ANTHROPIC_API_KEY: null, OPENAI_API_KEY: null, PLAIN: 'yes', CLAUDECODE: null, CLAUDE_CODE_SSE_PORT: null, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_ENTRYPOINT: 'cubex' })
    recordPath = join(dir, `record-key-${counter}.jsonl`)
    await open({ ANTHROPIC_API_KEY: 'sk-ant-test' }, {}, { passEnv: ['ANTHROPIC_API_KEY'] })
    expect(started().env.ANTHROPIC_API_KEY).toBe('sk-ant-test')
  })

  it('says it is not installed, and what to do, when no program is found', async () => {
    const error = await failure(open({}, { launch: () => { throw new LaunchError('"claude" was not found on PATH.') } }))
    expect(error.message).toContain('was not found')
    expect(error.hint).toContain('Claude desktop app')
  })
})

describe('a conversation', () => {
  it('returns what Claude Code said, turn after turn, in the same session', async () => {
    const agent = await open()
    expect(await agent.prompt('@claude say first')).toMatchObject({ text: 'first', stopReason: 'end_turn', capped: false })
    expect((await agent.prompt('@claude say second')).text).toBe('second')
    expect(recorded().filter((entry) => entry.received?.type === 'user')).toHaveLength(2)
  })

  it('reports a tool call as steps that run and finish', async () => {
    const agent = await open()
    const events: AcpEvent[] = []
    await agent.prompt(read(), { onEvent: (event) => events.push(event) })
    expect(events.map((event) => `${event.title}:${event.kind}:${event.state}`)).toEqual(['Read src/a.ts:read:running', 'Read src/a.ts:read:done'])
  })

  it('stops a message that is cancelled and goes on to the next', async () => {
    const agent = await open()
    const controller = new AbortController()
    const pending = agent.prompt('@claude say working\n@claude hang', { signal: controller.signal })
    await waitFor(() => recorded().some((entry) => entry.received?.type === 'user'))
    controller.abort()
    expect((await failure(pending)).message).toBe('Cancelled.')
    expect(recorded().some((entry) => (entry.received?.request as { subtype?: string } | undefined)?.subtype === 'interrupt')).toBe(true)
    expect(agent.alive).toBe(true)
    expect((await agent.prompt('@claude say back again')).text).toBe('back again')
  })
})

describe('what a consultation may do', () => {
  it('reads inside the folder, and Claude Code is told it may', async () => {
    const agent = await open()
    await agent.prompt(read())
    expect(answers()).toEqual([{ behavior: 'allow', updatedInput: { file_path: join(dir, 'src', 'a.ts') } }])
  })

  it('is refused every change, and Claude Code is told so in words it can act on', async () => {
    const agent = await open({ MOCK_REAL_WRITE: '1' })
    const events: AcpEvent[] = []
    const reply = await agent.prompt(`${write('notes.txt', 'x')}\n@claude say I could not write it.`, { onEvent: (event) => events.push(event) })
    expect(reply.text).toBe('I could not write it.')
    expect(answers()).toEqual([{ behavior: 'deny', message: 'Cubex did not allow this. Carry on without it, or stop and say what you could not do.' }])
    expect(events.at(-1)).toMatchObject({ kind: 'edit', state: 'failed' })
    expect(existsSync(join(dir, 'notes.txt'))).toBe(false)
  })

  it('is refused a command, a fetch and a tool it has never heard of', async () => {
    const agent = await open()
    await agent.prompt('@claude tool Bash {"command":"echo hi"}\n@claude tool WebFetch {"url":"https://example.com"}\n@claude tool Mystery {}')
    expect(answers().map((answer) => answer.behavior)).toEqual(['deny', 'deny', 'deny'])
  })

  it('is refused a read outside the folder, even one of the right kind', async () => {
    const agent = await open()
    await agent.prompt(`@claude tool Read ${JSON.stringify({ file_path: join(tmpdir(), 'cubex-claude-elsewhere.txt') })}`)
    expect(answers().map((answer) => answer.behavior)).toEqual(['deny'])
  })
})

describe('what a task may do', () => {
  const policyFor = (over: { mode?: 'default' | 'acceptEdits' | 'bypass' | 'plan'; ask?: (question: DelegateQuestion) => Promise<boolean>; changed?: string[][]; readOnly?: boolean } = {}) => createDelegatePolicy({
    root: dir,
    agent: 'Claude Code',
    mode: () => over.mode ?? 'default',
    readOnly: over.readOnly ?? false,
    ask: over.ask ?? (async () => true),
    beforeChange: (paths) => { over.changed?.push(paths) },
    isProtected: () => false,
    isReadOnlyCommand: (command) => command === 'git status'
  })

  it('asks the person about a change, shows what it changes, and writes it when they agree', async () => {
    const questions: DelegateQuestion[] = []
    const changed: string[][] = []
    const agent = await open({ MOCK_REAL_WRITE: '1' }, { policy: policyFor({ ask: async (question) => { questions.push(question); return true }, changed }) })
    await agent.prompt(write('notes.txt', 'hello\n'))
    expect(questions).toHaveLength(1)
    expect(questions[0]).toMatchObject({ agent: 'Claude Code', action: 'edit', target: 'notes.txt', title: 'Claude Code wants to edit notes.txt' })
    expect(questions[0]!.detail).toContain('+hello')
    expect(changed).toEqual([[join(dir, 'notes.txt')]])
    expect(readFileSync(join(dir, 'notes.txt'), 'utf8')).toBe('hello\n')
    rmSync(join(dir, 'notes.txt'))
  })

  it('does not write it when they say no, and keeps nothing', async () => {
    const changed: string[][] = []
    const agent = await open({ MOCK_REAL_WRITE: '1' }, { policy: policyFor({ ask: async () => false, changed }) })
    await agent.prompt(write('refused.txt', 'x'))
    expect(answers()).toMatchObject([{ behavior: 'deny' }])
    expect(existsSync(join(dir, 'refused.txt'))).toBe(false)
    expect(changed).toEqual([])
  })

  it('asks before a command, with the command itself in the question, and lets a read-only one through', async () => {
    const questions: DelegateQuestion[] = []
    const agent = await open({}, { policy: policyFor({ ask: async (question) => { questions.push(question); return true } }) })
    await agent.prompt('@claude tool Bash {"command":"git status"}\n@claude tool PowerShell {"command":"npm test"}')
    expect(questions.map((question) => question.command)).toEqual(['npm test'])
    expect(answers().map((answer) => answer.behavior)).toEqual(['allow', 'allow'])
  })

  it('refuses a change outside the project in every mode, bypass included', async () => {
    const agent = await open({}, { policy: policyFor({ mode: 'bypass' }) })
    await agent.prompt(`@claude tool Write ${JSON.stringify({ file_path: join(tmpdir(), 'cubex-claude-outside.txt'), content: 'x' })}`)
    expect(answers().map((answer) => answer.behavior)).toEqual(['deny'])
  })

  it('refuses to change the mode, whatever the person would answer, and asks about a tool it does not know', async () => {
    const questions: DelegateQuestion[] = []
    const agent = await open({}, { policy: policyFor({ ask: async (question) => { questions.push(question); return true } }) })
    await agent.prompt('@claude tool ExitPlanMode {}\n@claude tool Mystery {}')
    expect(answers().map((answer) => answer.behavior)).toEqual(['deny', 'allow'])
    expect(questions.map((question) => question.title)).toEqual(['Claude Code wants to use a tool: Use Mystery'])
  })
})

describe('a tool that ran without a question', () => {
  it('ends the turn and the program when it changed something, because Cubex cannot hold it to the policy any more', async () => {
    const agent = await open()
    const error = await failure(agent.prompt('@claude silent Write {"file_path":"x.txt","content":"y"}'))
    expect(error.message).toContain('did this without asking: Write x.txt')
    expect(error.hint).toContain('managed policy')
    await waitFor(() => !agent.alive)
  })
})
