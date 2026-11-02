import { IDLE_SIGN_IN, installIsRunning, signInIsRunning, type AntigravityActionResult, type AntigravityInstallState, type AntigravitySignInState, type AntigravityStatus } from '../../../../shared/antigravity'
import type { CubexAPI } from '../../../../shared/ipc'
import type { PreviewSeed } from './index'

/**
 * Antigravity in the browser preview, where nothing is downloaded and no browser is opened; the answers are canned and the install
 * and the sign-in run as a small simulation, so the whole path can be walked and every state reviewed.
 *
 *   ?seed=1&agy=none          the default: the desktop app is found, the runtime is not installed (Install runs a 5 second simulation)
 *   ?seed=1&agy=nodesktop     the same without the desktop app
 *   ?seed=1&agy=downloading   an install held at 40 percent; Cancel works
 *   ?seed=1&agy=extracting    held while unpacking
 *   ?seed=1&agy=verifying     held while checking
 *   ?seed=1&agy=failed        the install failed its checksum
 *   ?seed=1&agy=cancelled     the last install was cancelled
 *   ?seed=1&agy=installed     installed, not signed in (Sign in opens a simulated page and finishes after 6 seconds)
 *   ?seed=1&agy=waiting       the sign-in page is open and the runtime is waiting, held
 *   ?seed=1&agy=signinfailed  the account has no Antigravity subscription
 *   ?seed=1&agy=signedin      installed and signed in
 *   ?seed=1&agy=update        an older runtime is installed and signed in
 *   ?seed=1&agy=unsupported   Google publishes no runtime for this computer
 *   ?seed=1&agy=localonly     local-only mode is on
 * Extra: `agyhold=1` keeps a simulated install or sign-in from finishing, `agyfail=1` makes Install fail the checksum, and
 * `agyrefuse=1` makes every request a refusal.
 */

const TOTAL = 124_509_787
const IDLE: AntigravityInstallState = { operationId: null, phase: 'idle', downloadedBytes: 0, totalBytes: TOTAL, version: '1.3.0', installedVersion: null, canRemove: false, message: null }
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=preview&redirect_uri=http%3A%2F%2F127.0.0.1%3A45123%2F'
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function initial(mode: string): AntigravityStatus {
  const installed: Partial<AntigravityInstallState> = { phase: 'succeeded', installedVersion: '1.3.0', canRemove: true }
  const base: AntigravityStatus = {
    supported: mode !== 'unsupported',
    desktopApp: mode !== 'nodesktop',
    runtime: { ...IDLE },
    signedIn: false,
    signIn: IDLE_SIGN_IN,
    downloadBytes: mode === 'unsupported' ? null : TOTAL,
    diskBytes: mode === 'unsupported' ? null : 81_437_336 + 145_548_952,
    termsUrl: 'https://antigravity.google/terms',
    localOnly: mode === 'localonly'
  }
  const runtime = (patch: Partial<AntigravityInstallState>): AntigravityStatus => ({ ...base, runtime: { ...IDLE, ...patch } })
  switch (mode) {
    case 'downloading': return runtime({ phase: 'downloading', operationId: 'op-1', downloadedBytes: Math.round(TOTAL * 0.4), canRemove: true, message: 'Downloading Google\'s Antigravity runtime.' })
    case 'extracting': return runtime({ phase: 'extracting', operationId: 'op-1', downloadedBytes: TOTAL, canRemove: true, message: 'Extracting the verified runtime.' })
    case 'verifying': return runtime({ phase: 'verifying', operationId: 'op-1', downloadedBytes: TOTAL, canRemove: true, message: 'Checking the downloaded runtime.' })
    case 'failed': return runtime({ phase: 'failed', operationId: 'op-1', message: 'The Antigravity download failed its size or SHA-256 check. Nothing was installed.' })
    case 'cancelled': return runtime({ phase: 'cancelled', operationId: 'op-1', message: 'Installation cancelled. The previous runtime is unchanged.' })
    case 'installed': return runtime(installed)
    case 'waiting':
      return { ...runtime(installed), signIn: { phase: 'waiting', flowId: 'flow-1', authorizationUrl: AUTH_URL, expiresAt: Date.now() + 300_000, message: 'Google\'s sign-in page opened in your browser. Finish signing in there.' } }
    case 'signinfailed':
      return { ...runtime(installed), signIn: { phase: 'failed', flowId: null, authorizationUrl: null, expiresAt: null, message: 'Google requires an eligible Antigravity subscription for this account.' } }
    case 'signedin': return { ...runtime(installed), signedIn: true }
    case 'update': return { ...runtime({ ...installed, installedVersion: '1.2.0' }), signedIn: true }
    case 'localonly': return base
    default: return base
  }
}

/** Where the simulated install stands, shared with the agents seed so a saved Antigravity agent follows it. */
let shared: AntigravityStatus | undefined
export function previewRuntimeInstalled(): boolean | undefined {
  return shared ? shared.runtime.installedVersion !== null : undefined
}

function antigravityApi(flags: URLSearchParams): Partial<CubexAPI> {
  const mode = flags.get('agy') ?? 'none'
  const hold = flags.get('agyhold') === '1'
  const refuse = flags.get('agyrefuse') === '1'
  const listeners = new Set<(status: AntigravityStatus) => void>()
  let status = initial(mode)
  shared = status
  let installRun = 0
  let signInRun = 0

  const publish = (next: AntigravityStatus): void => {
    status = next
    shared = next
    listeners.forEach((listener) => listener(status))
  }
  const runtime = (patch: Partial<AntigravityInstallState>): void => publish({ ...status, runtime: { ...status.runtime, ...patch } })
  const signIn = (patch: Partial<AntigravitySignInState>): void => publish({ ...status, signIn: { ...status.signIn, ...patch } })
  const ok = (message: string): AntigravityActionResult => ({ ok: true, message })
  const no = (message: string): AntigravityActionResult => ({ ok: false, message })

  async function install(run: number): Promise<void> {
    const alive = (): boolean => installRun === run && installIsRunning(status.runtime)
    const steps = 20
    for (let step = 1; step <= steps; step++) {
      await wait(250)
      if (!alive()) return
      runtime({ downloadedBytes: Math.round((TOTAL * step) / steps) })
      if (hold && step === 8) return
    }
    runtime({ phase: 'extracting', message: 'Extracting the verified runtime.' })
    await wait(1_000)
    if (!alive()) return
    runtime({ phase: 'verifying', message: 'Checking the downloaded runtime.' })
    await wait(1_000)
    if (!alive()) return
    if (flags.get('agyfail') === '1') {
      runtime({ phase: 'failed', message: 'The downloaded Antigravity runtime could not start in this environment.' })
      return
    }
    runtime({ phase: 'succeeded', installedVersion: '1.3.0', canRemove: true, message: null })
  }

  async function signInFlow(run: number): Promise<void> {
    const alive = (): boolean => signInRun === run && signInIsRunning(status.signIn)
    await wait(500)
    if (!alive()) return
    signIn({ phase: 'waiting', authorizationUrl: AUTH_URL, message: 'Google\'s sign-in page opened in your browser. Finish signing in there.' })
    if (hold) return
    await wait(6_000)
    if (!alive()) return
    publish({ ...status, signedIn: true, signIn: { phase: 'succeeded', flowId: null, authorizationUrl: null, expiresAt: null, message: 'Signed in with Google.' } })
  }

  return {
    getAntigravityStatus: async () => status,
    onAntigravityState: (cb) => {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
    installAntigravity: async () => {
      if (refuse) return no('Cubex could not start the download. Check your connection, then try again.')
      if (status.localOnly) return no('Local-only mode is on, so nothing is downloaded or started. Turn it off under Privacy to set up Antigravity.')
      if (installIsRunning(status.runtime)) return ok('The runtime is already being installed.')
      const run = ++installRun
      runtime({ phase: 'downloading', operationId: `op-${run + 1}`, downloadedBytes: 0, message: 'Downloading Google\'s Antigravity runtime.', canRemove: true })
      void install(run)
      return ok('Downloading Google\'s Antigravity runtime.')
    },
    cancelAntigravityInstall: async () => {
      installRun++
      runtime({ phase: 'cancelled', message: 'Installation cancelled. The previous runtime is unchanged.', canRemove: status.runtime.installedVersion !== null })
      return ok('Cancelling the installation.')
    },
    removeAntigravity: async () => {
      if (refuse) return no('Antigravity is still running. Stop its task or wait for it to finish, then remove the runtime.')
      installRun++
      signInRun++
      publish({ ...status, runtime: { ...IDLE }, signedIn: false, signIn: IDLE_SIGN_IN })
      return ok('The Antigravity runtime and its sign-in were removed.')
    },
    signInAntigravity: async () => {
      if (refuse) return no('Antigravity is signing out. Try again when it has finished.')
      if (status.runtime.installedVersion === null) return no('Install the Antigravity runtime first.')
      const run = ++signInRun
      signIn({ phase: 'starting', flowId: `flow-${run + 1}`, authorizationUrl: null, expiresAt: Date.now() + 300_000, message: 'Starting Google sign-in.' })
      void signInFlow(run)
      return ok('Starting Google sign-in.')
    },
    cancelAntigravitySignIn: async () => {
      signInRun++
      signIn({ phase: 'cancelled', flowId: null, authorizationUrl: null, expiresAt: null, message: 'Google sign-in was cancelled.' })
      return ok('Google sign-in was cancelled.')
    },
    openAntigravitySignIn: async () => (status.signIn.authorizationUrl ? ok('Google\'s sign-in page opened in your browser.') : no('There is no Google sign-in page to open. Start signing in again.')),
    signOutAntigravity: async () => {
      await wait(600)
      signInRun++
      publish({ ...status, signedIn: false, signIn: IDLE_SIGN_IN })
      return ok('Signed out of Google.')
    }
  }
}

export const seed: PreviewSeed = {
  // The agents seed also answers for the Settings page: this one wins for the Antigravity methods only.
  order: 110,
  api: (flags) => antigravityApi(flags)
}
