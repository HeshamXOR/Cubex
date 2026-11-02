/**
 * Google's Antigravity as Cubex sets it up and shows it: the runtime Cubex installs (Google's own ACP server, downloaded from
 * Google on request), the Google sign-in it keeps, and what else of Antigravity is on this computer. Pure types and words, so the
 * Settings page and the main process say the same things.
 */

export type AntigravityInstallPhase = 'idle' | 'downloading' | 'extracting' | 'verifying' | 'succeeded' | 'failed' | 'cancelled'

/** Where an install of the runtime is, and what is installed. */
export interface AntigravityInstallState {
  /** Names the install that is going or went last, so a cancel is for the one on the screen. */
  operationId: string | null
  phase: AntigravityInstallPhase
  downloadedBytes: number
  totalBytes: number | null
  /** The release Cubex would install. */
  version: string | null
  installedVersion: string | null
  /** There is something of Cubex's to remove. */
  canRemove: boolean
  message: string | null
}

export type AntigravitySignInPhase = 'idle' | 'starting' | 'waiting' | 'verifying' | 'succeeded' | 'failed' | 'cancelled'

export interface AntigravitySignInState {
  phase: AntigravitySignInPhase
  flowId: string | null
  /** Google's sign-in page, when it is waiting for the person. Only ever an address on accounts.google.com. */
  authorizationUrl: string | null
  /** When the sign-in stops waiting, in milliseconds since 1970. */
  expiresAt: number | null
  message: string | null
}

export interface AntigravityStatus {
  /** Google publishes a runtime for this computer. */
  supported: boolean
  /** The Antigravity desktop app is installed. Cubex cannot use it, and says so. */
  desktopApp: boolean
  runtime: AntigravityInstallState
  /** The runtime has saved a Google sign-in. Cubex only knows that the file is there. */
  signedIn: boolean
  signIn: AntigravitySignInState
  /** What the download is, in bytes. */
  downloadBytes: number | null
  /** What the unpacked runtime takes on disk, in bytes. */
  diskBytes: number | null
  termsUrl: string
  /** Local-only mode is on: nothing is downloaded and nothing is started. */
  localOnly: boolean
}

/** What asking for an action came to. A refusal says why and what to do. */
export interface AntigravityActionResult {
  ok: boolean
  message: string
}

export const IDLE_SIGN_IN: AntigravitySignInState = { phase: 'idle', flowId: null, authorizationUrl: null, expiresAt: null, message: null }

/** Whether an install is going. */
export function installIsRunning(state: Pick<AntigravityInstallState, 'phase'>): boolean {
  return state.phase === 'downloading' || state.phase === 'extracting' || state.phase === 'verifying'
}

/** Whether a sign-in is going. */
export function signInIsRunning(state: Pick<AntigravitySignInState, 'phase'>): boolean {
  return state.phase === 'starting' || state.phase === 'waiting' || state.phase === 'verifying'
}

/** Bytes as a person reads a size: "124 MB". Megabytes of 1,000,000, as downloads are given. */
export function megabytes(bytes: number): string {
  const mb = bytes / 1_000_000
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`
}
