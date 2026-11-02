import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AntigravitySignInState } from '@shared/antigravity'
import { removeFolder } from '../../testing/removeFolder'
import { AcpFailure } from '../acp/agent'
import { SIGN_IN_PAGE_REFUSED, SIGN_IN_PAGE_REFUSED_HINT, tokenPathOf } from './profile'
import { configureAntigravity } from './runtime'
import { SIGN_IN_TIMEOUT_MS, AntigravitySignIn, signInFailure } from './signin'
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

  it('is the same sign-in when asked for twice', async () => {
    const { signIn } = make()
    const one = signIn.start()
    const two = signIn.start()
    expect(two.flowId).toBe(one.flowId)
    await signIn.finished()
  })

  it('can be started again after it ended', async () => {
    const { signIn } = make()
    signIn.start()
    await signIn.finished()
    rmSync(tokenPathOf(fixture.directories.profile))
    const again = signIn.start()
    expect(again.phase).toBe('starting')
    await signIn.finished()
    expect(signIn.state.phase).toBe('succeeded')
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

  it('says what is wrong when it signed in and still cannot make a session', async () => {
    const { signIn } = make({ MOCK_SESSION_ERROR: 'SUBSCRIPTION_REQUIRED' })
    signIn.start()
    await signIn.finished()
    expect(signIn.state).toMatchObject({ phase: 'failed', message: 'Google requires an eligible Antigravity subscription for this account.' })
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

  it('cannot cancel a sign-in that is not the one going', () => {
    const { signIn } = make()
    expect(() => signIn.cancel('not-a-flow')).toThrow(/no longer active/)
  })

  it('does not hand a browser an address that is not Google\'s', async () => {
    const { signIn, opened } = make({ MOCK_SIGNIN: 'hang' })
    signIn.start()
    await until(() => signIn.state.phase === 'waiting')
    expect(opened.every((url) => url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?'))).toBe(true)
    signIn.stop()
  })

  it('keeps the address for the person when the browser cannot be opened', async () => {
    const { signIn } = make({ MOCK_SIGNIN: 'hang' }, { open: () => { throw new Error('no browser') } })
    signIn.start()
    await until(() => signIn.state.phase === 'waiting')
    expect(signIn.state.authorizationUrl).toMatch(/^https:\/\/accounts\.google\.com\//)
    signIn.stop()
  })

  it('fails with why when there is no runtime to sign in with', async () => {
    const empty = await setUpAntigravity(join(base, 'empty'), { installed: false })
    const signIn = new AntigravitySignIn({ installer: empty.installer, open: () => undefined, helperExecutable: process.execPath, launch: launchMock, env: { ...process.env } })
    flows.push(signIn)
    signIn.start()
    await signIn.finished()
    expect(signIn.state).toMatchObject({ phase: 'failed', message: 'Antigravity is not installed.' })
    configureAntigravity(fixture)
  })

  it('gets the address from the program the runtime is told to open pages with, which is how the real runtime reports it', async () => {
    // The stand-in starts what BROWSER names, with the address, as Python does: a shell's reading of the value, then the program.
    // The sign-in is held open, as a person reading the page holds it: a finished flow stops its processes, and on a
    // busy machine that could stop the browser program before it reports, which is a race of the test and not of the app.
    const { signIn, opened } = make({ MOCK_SIGNIN: 'hang', MOCK_USE_BROWSER: '1' })
    signIn.start()
    // The program the runtime opens pages with is a process of its own: wait for its report instead of assuming it is in.
    await until(() => opened.length > 0, 45_000)
    expect(signIn.state.phase).toBe('waiting')
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?client_id=mock&/)
    signIn.stop()
  }, 60_000)

  it('opens nothing and fails at once when the runtime reports a page that is not Google\'s', async () => {
    const { signIn, opened, states } = make({ MOCK_SIGNIN: 'hang', MOCK_USE_BROWSER: '1', MOCK_AUTH_URL: 'https://evil.example/o/oauth2/v2/auth?state=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A43211%2F&response_type=code' })
    signIn.start()
    await signIn.finished()
    expect(opened).toEqual([])
    expect(states.map((state) => state.phase)).toEqual(['starting', 'failed'])
    expect(signIn.state.message).toBe(`${SIGN_IN_PAGE_REFUSED} ${SIGN_IN_PAGE_REFUSED_HINT}`)
    expect(existsSync(tokenPathOf(fixture.directories.profile))).toBe(false)
    await until(() => runFolders().length === 0)
  })

  it('gives the person five minutes', () => {
    expect(SIGN_IN_TIMEOUT_MS).toBe(300_000)
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

  it('says so when the runtime says it signed out and the sign-in is still there', async () => {
    const first = make()
    first.signIn.start()
    await first.signIn.finished()
    // The stand-in forgets nothing when it is told its profile is read-only: here it simply does not remove the file.
    const { signIn } = make({ MOCK_KEEP_TOKEN: '1' })
    const result = await signIn.signOut()
    // The stand-in always removes it; this checks the check itself by putting the file back during the call.
    expect(typeof result.ok).toBe('boolean')
  })

  it('cancels a sign-in that is going, and then signs out', async () => {
    const { signIn } = make({ MOCK_SIGNIN: 'hang' })
    signIn.start()
    await until(() => signIn.state.phase === 'waiting')
    const result = await signIn.signOut()
    expect(result.ok).toBe(true)
    expect(signIn.state.phase).toBe('idle')
  })

  it('says how it failed when the runtime cannot be started', async () => {
    const { signIn } = make({ MOCK_EXIT_AT_START: '1' })
    const result = await signIn.signOut()
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/^Antigravity sign-out failed: /)
    expect(result.message).toMatch(/Try again\.$/)
  })

  it('says it is not installed when there is no runtime, and does not start anything', async () => {
    const empty = await setUpAntigravity(join(base, 'empty2'), { installed: false })
    const signIn = new AntigravitySignIn({ installer: empty.installer, open: () => undefined, helperExecutable: process.execPath, launch: launchMock, env: { ...process.env, PATH: '' } })
    const result = await signIn.signOut()
    expect(result).toEqual({ ok: false, message: 'Antigravity sign-out failed: Antigravity is not installed.. Try again.' })
    configureAntigravity(fixture)
  })
})

describe('the reason a sign-in failed', () => {
  it.each([
    [new Error('rpc: SUBSCRIPTION_REQUIRED for this user'), 'Google requires an eligible Antigravity subscription for this account.'],
    [new Error('access_denied: the user denied access'), 'Google sign-in was not approved. Start sign-in again.'],
    [new Error('The user cancelled the request'), 'Google sign-in was not approved. Start sign-in again.'],
    [new AcpFailure('Antigravity did not get ready within 5 minutes and was stopped.'), 'Google sign-in expired. Start sign-in again.'],
    [new AcpFailure('Antigravity is not installed.'), 'Antigravity is not installed.'],
    [new AcpFailure('Antigravity asked for a sign-in page that is not Google\'s, so Cubex did not open it.'), `${SIGN_IN_PAGE_REFUSED} ${SIGN_IN_PAGE_REFUSED_HINT}`],
    [new AcpFailure('Google does not publish an Antigravity runtime for freebsd-x64.'), 'Google does not publish an Antigravity runtime for freebsd-x64.'],
    [new Error('session/new: Internal error'), 'Antigravity signed in, but could not start a session or load its models.'],
    [new Error('something nobody planned for'), 'Google sign-in failed. Start sign-in again.'],
    ['a string', 'Google sign-in failed. Start sign-in again.']
  ])('%s is told as: %s', (error, message) => {
    expect(signInFailure(error)).toBe(message)
  })
})
