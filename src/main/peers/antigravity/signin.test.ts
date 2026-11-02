import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AntigravitySignInState } from '@shared/antigravity'
import { removeFolder } from '../../testing/removeFolder'
import { tokenPathOf } from './profile'
import { configureAntigravity } from './runtime'
import { AntigravitySignIn } from './signin'
import { launchMock, setUpAntigravity, type Fixture } from './testing/fixtures'

let base: string
let fixture: Fixture
let counter = 0
const flows: AntigravitySignIn[] = []

beforeAll(async () => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'cubex-agy-signin-test-')))
  fixture = await setUpAntigravity(join(base, 'agy'))
})
afterAll(async () => {
  configureAntigravity(undefined)
  await removeFolder(base)
})
beforeEach(() => { counter++ })
afterEach(() => {
  for (const flow of flows.splice(0)) flow.stop()
  rmSync(tokenPathOf(fixture.directories.profile), { force: true })
})

const runFolders = (): string[] => { try { return readdirSync(fixture.directories.temp).filter((name) => name.startsWith('run-')) } catch { return [] } }
const until = async (condition: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms
  while (!condition() && Date.now() < end) await new Promise((done) => setTimeout(done, 20))
  expect(condition()).toBe(true)
}

function make(env: Record<string, string> = {}, over: { timeoutMs?: number; open?: (url: string) => void } = {}): { signIn: AntigravitySignIn; opened: string[]; states: AntigravitySignInState[] } {
  const opened: string[] = []
  const states: AntigravitySignInState[] = []
  const signIn = new AntigravitySignIn({
    installer: fixture.installer,
    open: over.open ?? ((url) => { opened.push(url) }),
    env: { ...process.env, MOCK_RECORD: join(base, `signin-${counter}.jsonl`), ...env },
    helperExecutable: process.execPath,
    launch: launchMock,
    ...(over.timeoutMs ? { timeoutMs: over.timeoutMs } : {})
  })
  signIn.subscribe((state) => states.push(state))
  flows.push(signIn)
  return { signIn, opened, states }
}

describe('signing in', () => {
  it('opens Google\'s sign-in page in the browser, waits for the person, and ends signed in with the sign-in saved', async () => {
    const { signIn, opened, states } = make()
    const first = signIn.start()
    expect(first).toMatchObject({ phase: 'starting', message: 'Starting Google sign-in.' })
    expect(first.flowId).toBeTruthy()
    expect(first.expiresAt).toBeGreaterThan(Date.now())
    await signIn.finished()
    expect(signIn.state).toEqual({ phase: 'succeeded', flowId: null, authorizationUrl: null, expiresAt: null, message: 'Signed in with Google.' })
    expect(states.map((state) => state.phase)).toEqual(['starting', 'waiting', 'succeeded'])
    // The address went to the browser once, and was in the state for the person to open again while it waited.
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/)
    expect(states[1]!.authorizationUrl).toBe(opened[0])
    expect(existsSync(tokenPathOf(fixture.directories.profile))).toBe(true)
    await until(() => runFolders().length === 0)
  })

  it('goes straight to signed in when a sign-in is already saved, and opens nothing', async () => {
    const first = make()
    first.signIn.start()
    await first.signIn.finished()
    const { signIn, opened } = make()
    signIn.start()
    await signIn.finished()
    expect(signIn.state.phase).toBe('succeeded')
    expect(opened).toEqual([])
  })

  it('says Google did not approve it, when the person said no', async () => {
    const { signIn } = make({ MOCK_SIGNIN: 'deny' })
    signIn.start()
    await signIn.finished()
    expect(signIn.state).toMatchObject({ phase: 'failed', message: 'Google sign-in was not approved. Start sign-in again.' })
    expect(existsSync(tokenPathOf(fixture.directories.profile))).toBe(false)
  })

  it('stops waiting when the time is up, and says it expired', async () => {
    const { signIn } = make({ MOCK_SIGNIN: 'hang' }, { timeoutMs: 700 })
    signIn.start()
    await signIn.finished()
    expect(signIn.state).toMatchObject({ phase: 'failed', message: 'Google sign-in expired. Start sign-in again.' })
    await until(() => runFolders().length === 0)
  })

  it('is cancelled by the person, stops the runtime, and ignores whatever comes after', async () => {
    const { signIn, states } = make({ MOCK_SIGNIN: 'hang' })
    const started = signIn.start()
    await until(() => signIn.state.phase === 'waiting')
    signIn.cancel(started.flowId!)
    expect(signIn.state).toMatchObject({ phase: 'cancelled', message: 'Google sign-in was cancelled.', authorizationUrl: null })
    await signIn.finished()
    await new Promise((done) => setTimeout(done, 100))
    expect(signIn.state.phase).toBe('cancelled')
    expect(states.at(-1)!.phase).toBe('cancelled')
    await until(() => runFolders().length === 0)
  })

  it('does not hand a browser an address that is not Google\'s', async () => {
    const { signIn, opened } = make({ MOCK_SIGNIN: 'hang' })
    signIn.start()
    await until(() => signIn.state.phase === 'waiting')
    expect(opened.every((url) => url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?'))).toBe(true)
    signIn.stop()
  })

  it('removes the folder the runtime worked in, however the sign-in ended, once the runtime is gone', async () => {
    // A temporary folder of this test's own: other test files run at the same time and make their folders in the shared one.
    const mine = mkdtempSync(join(base, 'tmp-'))
    const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR }
    process.env.TEMP = process.env.TMP = process.env.TMPDIR = mine
    try {
      const cancelled = make({ MOCK_SIGNIN: 'hang' })
      const started = cancelled.signIn.start()
      await until(() => cancelled.signIn.state.phase === 'waiting')
      cancelled.signIn.cancel(started.flowId!)
      await cancelled.signIn.finished()

      const expired = make({ MOCK_SIGNIN: 'hang' }, { timeoutMs: 700 })
      expired.signIn.start()
      await expired.signIn.finished()

      const refused = make({ MOCK_SIGNIN: 'hang', MOCK_USE_BROWSER: '1', MOCK_AUTH_URL: 'https://evil.example/o/oauth2/v2/auth?state=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A43211%2F&response_type=code' })
      refused.signIn.start()
      await refused.signIn.finished()

      expect(readdirSync(mine)).toEqual([])
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})

describe('signing out', () => {
  it('asks the runtime to forget the sign-in, and the file is gone', async () => {
    const first = make()
    first.signIn.start()
    await first.signIn.finished()
    expect(existsSync(tokenPathOf(fixture.directories.profile))).toBe(true)
    const { signIn } = make()
    expect(await signIn.signOut()).toEqual({ ok: true, message: 'Signed out of Google.' })
    expect(existsSync(tokenPathOf(fixture.directories.profile))).toBe(false)
    expect(signIn.state.phase).toBe('idle')
    await until(() => runFolders().length === 0)
  })
})
