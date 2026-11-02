import { installIsRunning, megabytes, signInIsRunning, type AntigravityStatus } from '../../../shared/antigravity'
import type { FoundState } from './agentRows'

/**
 * What the Antigravity row of "Found on this PC" says and offers, decided from what the main process reported. Kept apart from the
 * component so the wording and the rules (which button when) are tested without drawing anything.
 *
 * Antigravity is not a program on PATH. The desktop app has nothing Cubex can talk to, so Cubex installs Google's own agent
 * runtime, from Google, when the person asks, and signs in to it with a Google account. The row walks that path in order:
 * install, sign in, add.
 */

export type AntigravityAction = 'install' | 'cancel-install' | 'sign-in' | 'cancel-sign-in' | 'open-page' | 'sign-out' | 'remove'

export interface AntigravityButton {
  action: AntigravityAction
  label: string
}

export interface AntigravityProgress {
  /** 0 to 1, or null when there is no figure to show. */
  fraction: number | null
  /** "37 of 125 MB", or the step it is on. */
  label: string
}

export interface AntigravityView {
  state: FoundState
  /** The line about where things stand: "Not signed in", "Signed in with Google", or what went wrong. */
  account: string
  /** Quieter text after the account line. */
  note?: string
  /** Where the desktop app was found: "Found in the Antigravity desktop app". */
  where?: string
  /** Paragraphs under the lines above: why Cubex sets up a runtime of its own and what that costs. */
  intro: string[]
  progress?: AntigravityProgress
  /** The one thing to do next. */
  primary?: AntigravityButton
  /** The rest, quieter. */
  secondary: AntigravityButton[]
  /** The agent can be added now: the runtime is there and signed in. */
  canAdd: boolean
  /** Work is going, so a spinner stands in for the check or triangle. */
  working: boolean
}

const button = (action: AntigravityAction, label: string): AntigravityButton => ({ action, label })

export function installProgress(state: AntigravityStatus['runtime']): AntigravityProgress | undefined {
  if (state.phase === 'downloading') {
    const total = state.totalBytes
    return total && total > 0
      ? { fraction: Math.min(1, state.downloadedBytes / total), label: `${megabytes(state.downloadedBytes)} of ${megabytes(total)}` }
      : { fraction: null, label: megabytes(state.downloadedBytes) }
  }
  if (state.phase === 'extracting') return { fraction: null, label: 'Unpacking' }
  if (state.phase === 'verifying') return { fraction: null, label: 'Checking' }
  return undefined
}

export function antigravityView(status: AntigravityStatus): AntigravityView {
  const where = status.desktopApp ? 'Found in the Antigravity desktop app' : undefined
  const base = { ...(where ? { where } : {}), intro: [] as string[], secondary: [] as AntigravityButton[], canAdd: false, working: false }
  const runtime = status.runtime
  const installed = runtime.installedVersion !== null

  if (!status.supported && !installed) {
    return { ...base, state: 'problem', account: 'Not available on this computer', intro: ['Google does not publish an Antigravity runtime for this system.'] }
  }

  if (installIsRunning(runtime)) {
    const progress = installProgress(runtime)
    return {
      ...base,
      state: 'unknown',
      account: runtime.phase === 'downloading' ? 'Downloading the runtime' : runtime.phase === 'extracting' ? 'Unpacking the runtime' : 'Checking the runtime',
      ...(progress ? { progress } : {}),
      secondary: [button('cancel-install', 'Cancel')],
      working: true
    }
  }

  if (!installed) {
    const size = status.downloadBytes !== null && status.diskBytes !== null
      ? `The download is ${megabytes(status.downloadBytes)} from Google and takes ${megabytes(status.diskBytes)} on disk. Cubex checks it against a fixed checksum before it runs it.`
      : undefined
    const intro = [
      status.desktopApp
        ? 'The Antigravity desktop app is installed, but Cubex cannot drive it. Cubex uses Google\'s separate agent runtime instead and signs in to it with your Google account.'
        : 'Cubex uses Google\'s agent runtime and signs in to it with your Google account.',
      ...(size ? [size] : [])
    ]
    if (runtime.phase === 'failed') {
      return {
        ...base, intro, state: 'problem', account: runtime.message ?? 'The runtime could not be installed.',
        ...(status.localOnly ? {} : { primary: button('install', 'Try again') }),
        secondary: runtime.canRemove ? [button('remove', 'Remove')] : []
      }
    }
    if (status.localOnly) {
      return { ...base, intro: ['Local-only mode is on, so nothing is downloaded or started. Turn it off under Privacy to set up Antigravity.'], state: 'unknown', account: 'Not started' }
    }
    return {
      ...base, intro, state: 'signed-out', account: 'Runtime not installed',
      ...(runtime.phase === 'cancelled' ? { note: 'The last installation was cancelled.' } : {}),
      primary: button('install', 'Install the runtime')
    }
  }

  // The runtime is installed. When Cubex has a newer release than the one on disk, it can be updated from here.
  const newer = runtime.version !== null && runtime.version !== runtime.installedVersion
  const remove = button('remove', 'Remove')
  const update = newer && !status.localOnly ? [button('install', `Update to ${runtime.version}`)] : []
  // The version that is installed is shown beside the name, so the line only says when there is a newer one.
  const noted = newer ? { note: `Version ${runtime.version} is available` } : {}

  if (status.localOnly) {
    return { ...base, state: 'unknown', account: 'Not started', intro: ['Local-only mode is on, so Antigravity is not started. Turn it off under Privacy to use it.'], secondary: [remove] }
  }

  const signIn = status.signIn
  if (signInIsRunning(signIn)) {
    return {
      ...base,
      state: 'unknown',
      account: signIn.phase === 'waiting' ? 'Waiting for you to sign in with Google' : 'Signing in with Google',
      intro: [signIn.phase === 'waiting' ? 'Google\'s page opened in your browser. Finish signing in there.' : signIn.phase === 'verifying' ? 'Checking the sign-in.' : 'Starting the runtime.'],
      ...(signIn.phase === 'waiting' ? { primary: button('open-page', 'Open Google\'s page again') } : {}),
      secondary: [button('cancel-sign-in', 'Cancel')],
      working: true
    }
  }
  if (signIn.phase === 'failed') {
    return { ...base, state: 'problem', account: signIn.message ?? 'Google sign-in failed. Start sign-in again.', ...noted, primary: button('sign-in', 'Try again'), secondary: [...update, remove] }
  }
  if (!status.signedIn) {
    return { ...base, state: 'signed-out', account: 'Not signed in', ...noted, primary: button('sign-in', 'Sign in with Google'), secondary: [...update, remove] }
  }
  return { ...base, state: 'signed-in', account: 'Signed in with Google', ...noted, secondary: [...update, button('sign-out', 'Sign out'), remove], canAdd: true }
}

/** What a saved Antigravity agent says about itself, from the same status: its account line and the one button that helps. */
export function antigravityAccount(status: AntigravityStatus): { state: FoundState; text: string; action?: AntigravityAction; actionLabel?: string } | undefined {
  if (status.runtime.installedVersion === null) return undefined
  if (status.localOnly) return undefined
  const view = antigravityView(status)
  const action = view.primary && (view.primary.action === 'sign-in') ? view.primary : undefined
  return { state: view.state, text: view.account, ...(action ? { action: action.action, actionLabel: action.label } : {}) }
}
