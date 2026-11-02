import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newAcpPeer, type AcpPeer } from '@shared/peers'
import { removeFolder } from '../../testing/removeFolder'
import { AcpAgent, AcpFailure, type OpenOptions } from '../acp/agent'
import { createDelegatePolicy, type DelegateQuestion } from '../acp/delegatePolicy'
import { InstallError, type AntigravityExecutable } from './install'
import { tokenPathOf } from './profile'
import { antigravityProgramNames } from './release'
import { DEFAULT_RUNTIME_COMMAND, configureAntigravity, isExpectedRelease, resolveRuntime, validateRuntime } from './runtime'
import { launchMock, setUpAntigravity, type Fixture } from './testing/fixtures'

let base: string
let work: string
let recordPath: string
let counter = 0
let fixture: Fixture
const agents: AcpAgent[] = []
const names = antigravityProgramNames()

beforeAll(async () => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'cubex-agy-runtime-')))
  work = join(base, 'work')
  mkdirSync(work)
  fixture = await setUpAntigravity(join(base, 'agy'))
})
afterAll(async () => {
  configureAntigravity(undefined)
  await removeFolder(base)
})
beforeEach(() => { recordPath = join(base, `record-${++counter}.jsonl`) })
afterEach(() => {
  for (const agent of agents.splice(0)) agent.kill(true)
  rmSync(tokenPathOf(fixture.directories.profile), { force: true })
})

const peer = (over: Partial<AcpPeer> = {}): AcpPeer => ({ ...newAcpPeer('agy-acp', []), id: 'agy', ...over })
const signedIn = (): void => {
  mkdirSync(join(fixture.directories.profile, 'antigravity-acp'), { recursive: true })
  writeFileSync(tokenPathOf(fixture.directories.profile), '{"saved":true}\n')
}

async function open(env: Record<string, string> = {}, options: Partial<OpenOptions> = {}, over: Partial<AcpPeer> = {}): Promise<AcpAgent> {
  const agent = await AcpAgent.open({ peer: peer(over), cwd: work, env: { ...process.env, MOCK_RECORD: recordPath, ...env }, launch: launchMock, ...options })
  agents.push(agent)
  return agent
}

interface Entry { started?: { argv: string[]; cwd: string; env: Record<string, string | null> }; received?: Record<string, unknown> }
const recorded = (): Entry[] => {
  try { return readFileSync(recordPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Entry) } catch { return [] }
}
const started = (): NonNullable<Entry['started']> => recorded().find((entry) => entry.started)!.started!
const received = (method: string): Array<Record<string, unknown>> => recorded().map((entry) => entry.received).filter((message): message is Record<string, unknown> => message?.method === method)
const failure = async (work: Promise<unknown>): Promise<AcpFailure> => {
  const error = await work.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(AcpFailure)
  return error as AcpFailure
}
const until = async (condition: () => boolean, ms = 3_000): Promise<void> => {
  const end = Date.now() + ms
  while (!condition() && Date.now() < end) await new Promise((done) => setTimeout(done, 20))
  expect(condition()).toBe(true)
}

const taskPolicy = (ask: (question: DelegateQuestion) => Promise<boolean>) => createDelegatePolicy({
  root: work, agent: 'Antigravity', mode: () => 'default', readOnly: false, ask, beforeChange: () => undefined, isProtected: () => false, isReadOnlyCommand: () => false
})

describe('which runtime is started', () => {
  it('is the one the person pointed the agent at, when its harness is beside it', () => {
    const folder = join(base, 'custom')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, names.executable), 'exe', { mode: 0o755 })
    writeFileSync(join(folder, names.harness), 'harness', { mode: 0o755 })
    expect(resolveRuntime({ command: join(folder, names.executable) }, fixture.installer, process.env)).toMatchObject({ source: 'override', managedVersionDirectory: null })
  })

  it('is the one Cubex installed, when the agent is not pointed anywhere', () => {
    expect(resolveRuntime({ command: DEFAULT_RUNTIME_COMMAND }, fixture.installer, process.env)).toMatchObject({ source: 'managed', version: '1.3.0' })
    expect(resolveRuntime({ command: '' }, fixture.installer, process.env)).toMatchObject({ source: 'managed' })
  })
})

describe('an agent that is not signed in', () => {
  it('is not started for a chat that would have to sign in, and the person is told where to sign in', async () => {
    const error = await failure(open())
    expect(error.message).toBe('Antigravity is not signed in.')
    expect(error.hint).toContain('Sign in with Google')
  })
})

describe('an agent that is signed in', () => {
  it('answers a message', async () => {
    signedIn()
    const agent = await open()
    expect((await agent.prompt('@agy say hello from the runtime')).text).toBe('hello from the runtime')
  })

  it('works in the mode that asks, and never moves to the ones that do not', async () => {
    signedIn()
    const agent = await open()
    expect(agent.taskReadiness()).toMatchObject({ ready: true, mode: { id: 'default' } })
    expect(received('session/set_mode').map((message) => (message.params as { modeId: string }).modeId)).not.toEqual(expect.arrayContaining(['auto_edit', 'yolo']))
  })

  it('starts the runtime in its own profile, with no other login, with a folder of its own to unpack into and the helper for a browser', async () => {
    signedIn()
    await open({ GEMINI_API_KEY: 'k', GOOGLE_API_KEY: 'k', OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', GOOGLE_CLOUD_PROJECT: 'p', PLAIN: 'yes' })
    const { env, cwd } = started()
    expect(realpathSync.native(cwd)).toBe(work)
    expect(env.GEMINI_HOME).toBe(fixture.directories.profile)
    expect(env.AGY_ACP_FORCE_FILE_STORAGE).toBe('1')
    expect(env.BROWSER).toContain('__CUBEX_ANTIGRAVITY_AUTH_URL__')
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(env.ANTIGRAVITY_HARNESS_PATH).toBe(fixture.installer.resolve()!.harnessPath)
    for (const name of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_CLOUD_PROJECT']) expect(env[name], name).toBeNull()
    expect(env.PLAIN).toBe('yes')
    const temporary = process.platform === 'win32' ? env.TEMP : env.TMPDIR
    expect(temporary!.startsWith(fixture.directories.temp)).toBe(true)
    expect(temporary!.slice(fixture.directories.temp.length + 1)).toMatch(/^run-/)
  })

  it('refuses what the person refuses, with the runtime\'s own option for it', async () => {
    signedIn()
    const agent = await open({}, { policy: taskPolicy(async () => false) })
    expect((await agent.prompt('@agy tool {}')).text).toBe('the tool was refused (selected)')
  })

  it('is stopped when it is cancelled, and can answer the next message', async () => {
    signedIn()
    const agent = await open()
    const controller = new AbortController()
    const pending = agent.prompt('@agy hang', { signal: controller.signal })
    await until(() => received('session/prompt').length === 1)
    controller.abort()
    expect((await failure(pending)).message).toBe('Cancelled.')
    expect((await agent.prompt('@agy say back')).text).toBe('back')
  })
})

describe('checking a download', () => {
  const executable: AntigravityExecutable = { executablePath: 'unused', harnessPath: 'unused', source: 'managed', version: '1.3.0', managedVersionDirectory: null }
  const check = (env: Record<string, string> = {}, signal = new AbortController().signal) => validateRuntime({ helperExecutable: process.execPath, baseEnv: { ...process.env, ...env }, launch: launchMock, timeoutMs: 20_000 })(executable, '1.3.0', signal)

  it('refuses one that says it is another version', async () => {
    await expect(check({ MOCK_VERSION: '9.9.9' })).rejects.toThrow(InstallError)
    await expect(check({ MOCK_VERSION: '9.9.9' })).rejects.toThrow(/did not identify as the expected Google Antigravity release/)
  })
})

describe('what a release says about itself', () => {
  const good = {
    protocolVersion: 1,
    agentInfo: { name: 'antigravity-acp', version: '1.3.0' },
    agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} }, auth: { logout: {} } },
    authMethods: [{ id: 'oauth-personal' }]
  }

  it.each([
    ['another name', { ...good, agentInfo: { name: 'something-else', version: '1.3.0' } }],
    ['another version', { ...good, agentInfo: { name: 'antigravity-acp', version: '1.2.0' } }],
    ['another protocol', { ...good, protocolVersion: 3 }],
    ['no loading of sessions', { ...good, agentCapabilities: { ...good.agentCapabilities, loadSession: false } }],
    ['no resuming', { ...good, agentCapabilities: { ...good.agentCapabilities, sessionCapabilities: {} } }],
    ['no signing out', { ...good, agentCapabilities: { ...good.agentCapabilities, auth: {} } }],
    ['no sign-in with Google', { ...good, authMethods: [{ id: 'gemini-api-key' }] }],
    ['nothing at all', {}],
    ['not an object', 'text']
  ])('is refused with %s', (_name, init) => {
    expect(isExpectedRelease(init, '1.3.0')).toBe(false)
  })
})
