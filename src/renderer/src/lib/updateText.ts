import type { UpdateBusy, UpdateProgress, UpdateState } from '../../../shared/updates'
import { formatBytes, plural } from './format'

export type Update = NonNullable<UpdateState['update']>

/** The release as the card and the dialog name it: "Cubex 0.2.0". */
export const releaseLabel = (update: Update): string => `Cubex ${update.info.version}`

/** The words over a card for each stage of an update. */
export function noticeTitle(update: Update): string {
  switch (update.stage) {
    case 'available': return `${releaseLabel(update)} is available`
    case 'downloading': return `Downloading ${releaseLabel(update)}`
    case 'ready': return `${releaseLabel(update)} is ready`
    case 'installing': return 'Restarting to update'
  }
}

/** The line under that title. How far a download has got is on its progress line, not here. */
export function noticeDetail(state: UpdateState, update: Update): string {
  switch (update.stage) {
    case 'available': return canInstallUpdate(state, update) ? `You have ${state.currentVersion}.` : `You have ${state.currentVersion}. Get it from the release page.`
    case 'downloading': return `You have ${state.currentVersion}.`
    case 'ready': return 'Restart Cubex to finish updating.'
    case 'installing': return 'Cubex opens again in a moment.'
  }
}

/** "42 MB of 85 MB". Nothing has arrived yet while the first request is on its way. */
export function progressText(progress: UpdateProgress | undefined): string {
  if (!progress || progress.total <= 0 || progress.received <= 0) return 'Starting the download…'
  return `${formatBytes(progress.received)} of ${formatBytes(progress.total)}`
}

/** A whole percentage, or undefined while the size is not known. */
export function progressPercent(progress: UpdateProgress | undefined): number | undefined {
  if (!progress || progress.total <= 0) return undefined
  return Math.min(100, Math.max(0, Math.floor((progress.received / progress.total) * 100)))
}

/** What the window can offer for this release: Cubex replaces itself only from a copy the installer set up, with an installer it can verify. */
export function canInstallUpdate(state: UpdateState, update: Update): boolean {
  return state.canInstall && !!update.info.installer
}

/** Why this copy cannot do it by itself, in a sentence. Undefined when it can. */
export function installBlocker(state: UpdateState, update: Update): string | undefined {
  if (!state.canInstall) return state.cannotInstallReason ?? 'This copy cannot update itself. Download the installer from the release page.'
  if (!update.info.installer) return update.info.installerProblem ?? 'This release has no installer Cubex can use. Download it from the release page.'
  return undefined
}

/** The one step that moves an update on, as the button that takes it reads. */
export type NextStep =
  | { kind: 'download'; label: string }
  | { kind: 'restart'; label: string }
  | { kind: 'release'; label: string }
  | { kind: 'none' }

export function nextStep(state: UpdateState, update: Update): NextStep {
  switch (update.stage) {
    case 'available':
      return canInstallUpdate(state, update) ? { kind: 'download', label: update.error ? 'Try again' : 'Download update' } : { kind: 'release', label: 'View release' }
    case 'ready':
      return { kind: 'restart', label: update.error ? 'Try again' : 'Restart to update' }
    case 'downloading':
    case 'installing':
      return { kind: 'none' }
  }
}

/**
 * Which state of an update the person has already put off. "Later" hides the card until something about it changes:
 * a newer version, the next stage, or an error to read.
 */
export function dismissalKey(update: Update): string {
  return `${update.info.version}:${update.stage}${update.error ? ':error' : ''}`
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
export function agoText(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 60) return `${plural(minutes, 'minute')} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${plural(hours, 'hour')} ago`
  return `${plural(Math.floor(hours / 24), 'day')} ago`
}

/** What the Settings page says about the last look, one short sentence. The bytes of a download are on the card under it. */
export function statusText(state: UpdateState, now: number): string {
  const { check, update } = state
  if (update?.stage === 'downloading') return `Downloading Cubex ${update.info.version}.`
  if (update?.stage === 'installing') return 'Restarting to update.'
  if (check.status === 'checking') return 'Checking for updates…'
  const when = check.at === undefined ? undefined : agoText(check.at, now)
  if (update) {
    return update.stage === 'ready'
      ? `Cubex ${update.info.version} is downloaded and ready.`
      : `Cubex ${update.info.version} is available.${when ? ` Checked ${when}.` : ''}`
  }
  if (check.status === 'failed') return when ? `The last check did not work. The last good check was ${when}.` : 'The last check did not work.'
  if (check.status === 'done' && when) return `Cubex is up to date. Checked ${when}.`
  return 'Not checked yet.'
}

/** The sentence that asks before restarting over running work. */
export function busyText(busy: UpdateBusy): string {
  const parts = [
    busy.turns > 0 ? (busy.turns === 1 ? 'a session' : `${busy.turns} sessions`) : '',
    busy.tasks > 0 ? (busy.tasks === 1 ? 'a background task' : `${busy.tasks} background tasks`) : ''
  ].filter(Boolean)
  const subject = parts.join(' and ')
  const many = busy.turns + busy.tasks > 1
  return `${subject.charAt(0).toUpperCase()}${subject.slice(1)} ${many ? 'are' : 'is'} still working. Updating now stops ${many ? 'them' : 'it'}.`
}

/** "October 20, 2026", from the ISO date a release carries. Empty when there is none. */
export function releaseDate(iso: string | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
}
