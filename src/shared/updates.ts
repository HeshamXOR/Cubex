import { normalizeVersion } from './version'

/**
 * Updates: what the main process knows about newer releases of Cubex, as the window sees it. The main process owns the
 * state and pushes every change; the window only reads it and asks for the next step.
 */

/** The repository whose releases are checked. */
export const UPDATE_REPOSITORY = 'HeshamXOR/Cubex'

/** Release notes are cut here. They are shown as written, so a release with a very long body cannot fill the window. */
export const UPDATE_NOTES_LIMIT = 20_000

/**
 * A line of its own in a release's notes that ends what the window shows. Whatever follows (the download table, the
 * checksum) is for the release page, where a person does not have the app yet. The release workflow writes it.
 */
export const UPDATE_NOTES_END = '<!-- end of notes -->'

/** An installer larger than this is not downloaded. The real one is under 100 MB. */
export const UPDATE_MAX_BYTES = 500 * 1024 * 1024

export interface UpdateSettings {
  /** Look for a new version on its own, about every six hours. Off still allows "Check for updates". */
  auto: boolean
  /** A version the person chose to skip: automatic checks stay quiet about it, a newer one is offered again. */
  skippedVersion?: string
}

export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = { auto: true }

/** The stored block in its canonical shape; anything unusable falls back to the default. */
export function normalizeUpdateSettings(value: unknown): UpdateSettings {
  const stored = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const skipped = normalizeVersion(stored.skippedVersion)
  return {
    auto: typeof stored.auto === 'boolean' ? stored.auto : DEFAULT_UPDATE_SETTINGS.auto,
    ...(skipped ? { skippedVersion: skipped } : {})
  }
}

/** One published release, reduced to what the window shows. Addresses and checksums stay in the main process. */
export interface UpdateInfo {
  /** Without a leading v: "0.2.0". */
  version: string
  /** The release title. */
  name: string
  /** What changed, as Markdown, written by whoever published the release. Untrusted text. */
  notes: string
  /** The notes were longer than `UPDATE_NOTES_LIMIT` and are cut. */
  notesCut?: boolean
  /** When it was published, as an ISO date. */
  publishedAt?: string
  /** The release page on GitHub, the one place a person can always get the installer from. */
  pageUrl: string
  /** The Windows installer, when the release has one that Cubex can verify. */
  installer?: { name: string; size: number }
  /** Why Cubex cannot install this release for the person, in a sentence. Empty when it can. */
  installerProblem?: string
}

export type UpdateStage = 'available' | 'downloading' | 'ready' | 'installing'
/** `done` is a look that reached GitHub; whether it found anything newer is `update` being present. */
export type UpdateCheckStatus = 'idle' | 'checking' | 'done' | 'failed'

export interface UpdateProgress {
  received: number
  total: number
}

export interface UpdateState {
  currentVersion: string
  /** This copy can replace itself. False for a copy that was not set up by the installer. */
  canInstall: boolean
  /** When it cannot, why, in a sentence. */
  cannotInstallReason?: string
  /** The last look at the releases. `at` is when one last reached GitHub. */
  check: { status: UpdateCheckStatus; at?: number; error?: string }
  /** A newer release, once one is known, and how far along getting it is. */
  update?: {
    info: UpdateInfo
    stage: UpdateStage
    /** The person skipped this version: it is not announced, but Settings still shows it. */
    skipped?: boolean
    progress?: UpdateProgress
    /** The last download or install attempt failed, in a sentence that says what to do. */
    error?: string
  }
}

/** What is still working when an update would restart Cubex. */
export interface UpdateBusy {
  turns: number
  tasks: number
}

export type UpdateInstallResult =
  | { ok: true }
  | { ok: false; reason: 'busy'; busy: UpdateBusy }
  | { ok: false; reason: 'failed'; message: string }

export interface UpdateInstallRequest {
  /** Restart even though work is running; it is stopped. */
  force?: boolean
}

/** The state of a copy before the main process has said anything, used by the window until the first answer. */
export function initialUpdateState(currentVersion: string): UpdateState {
  return { currentVersion, canInstall: false, check: { status: 'idle' } }
}
