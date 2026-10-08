import { describe, expect, it } from 'vitest'
import type { UpdateState } from '../../../shared/updates'
import {
  agoText, busyText, canInstallUpdate, dismissalKey, installBlocker, nextStep, noticeDetail, noticeTitle, progressPercent, progressText, releaseDate, releaseLabel, statusText,
  type Update
} from './updateText'

const info = (extra: Partial<Update['info']> = {}): Update['info'] => ({
  version: '0.2.0',
  name: 'Cubex 0.2.0',
  notes: '- A thing',
  pageUrl: 'https://github.com/HeshamXOR/Cubex/releases/tag/v0.2.0',
  installer: { name: 'Cubex-Setup-0.2.0.exe', size: 89_484_330 },
  ...extra
})
const update = (extra: Partial<Update> = {}, details: Partial<Update['info']> = {}): Update => ({ info: info(details), stage: 'available', ...extra })
const state = (extra: Partial<UpdateState> = {}): UpdateState => ({ currentVersion: '0.1.0', canInstall: true, check: { status: 'idle' }, ...extra })

describe('what a card says at each stage', () => {
  it('names the release and the stage', () => {
    expect(releaseLabel(update())).toBe('Cubex 0.2.0')
    expect(noticeTitle(update())).toBe('Cubex 0.2.0 is available')
    expect(noticeTitle(update({ stage: 'downloading' }))).toBe('Downloading Cubex 0.2.0')
    expect(noticeTitle(update({ stage: 'ready' }))).toBe('Cubex 0.2.0 is ready')
    expect(noticeTitle(update({ stage: 'installing' }))).toBe('Restarting to update')
  })

  it('says what the person has, what is under way, and what comes next', () => {
    expect(noticeDetail(state(), update())).toBe('You have 0.1.0.')
    expect(noticeDetail(state(), update({ stage: 'downloading', progress: { received: 44_040_192, total: 89_484_330 } }))).toBe('You have 0.1.0.')
    expect(noticeDetail(state(), update({ stage: 'ready' }))).toBe('Restart Cubex to finish updating.')
    expect(noticeDetail(state(), update({ stage: 'installing' }))).toBe('Cubex opens again in a moment.')
  })

  it('sends a copy that cannot update itself to the release page', () => {
    expect(noticeDetail(state({ canInstall: false }), update())).toBe('You have 0.1.0. Get it from the release page.')
    expect(noticeDetail(state(), update({}, { installer: undefined }))).toBe('You have 0.1.0. Get it from the release page.')
  })
})

describe('progress', () => {
  it('waits for the first bytes before it gives numbers', () => {
    expect(progressText(undefined)).toBe('Starting the download…')
    expect(progressText({ received: 0, total: 89_484_330 })).toBe('Starting the download…')
    expect(progressText({ received: 10, total: 0 })).toBe('Starting the download…')
  })

  it('is a whole percentage that never leaves 0 to 100', () => {
    expect(progressPercent(undefined)).toBeUndefined()
    expect(progressPercent({ received: 5, total: 0 })).toBeUndefined()
    expect(progressPercent({ received: 0, total: 200 })).toBe(0)
    expect(progressPercent({ received: 99, total: 200 })).toBe(49)
    expect(progressPercent({ received: 200, total: 200 })).toBe(100)
    expect(progressPercent({ received: 900, total: 200 })).toBe(100)
    expect(progressPercent({ received: -4, total: 200 })).toBe(0)
  })
})

describe('whether Cubex can install the update itself', () => {
  it('can for a copy the installer set up and a release with a verified installer', () => {
    expect(canInstallUpdate(state(), update())).toBe(true)
    expect(installBlocker(state(), update())).toBeUndefined()
  })

  it('cannot for a copy that is not set up that way, and says why', () => {
    const portable = state({ canInstall: false, cannotInstallReason: 'This copy was not set up with the Cubex installer, so it cannot update itself.' })
    expect(canInstallUpdate(portable, update())).toBe(false)
    expect(installBlocker(portable, update())).toBe('This copy was not set up with the Cubex installer, so it cannot update itself.')
    expect(installBlocker(state({ canInstall: false }), update())).toMatch(/cannot update itself/)
  })

  it('cannot for a release without an installer it can verify, and says why', () => {
    const bare = update({}, { installer: undefined, installerProblem: 'This release has no checksum, so Cubex will not install it for you. Download it from the release page.' })
    expect(canInstallUpdate(state(), bare)).toBe(false)
    expect(installBlocker(state(), bare)).toMatch(/no checksum/)
    expect(installBlocker(state(), update({}, { installer: undefined }))).toMatch(/no installer Cubex can use/)
  })
})

describe('nextStep', () => {
  it('is to download first, then to restart', () => {
    expect(nextStep(state(), update())).toEqual({ kind: 'download', label: 'Download update' })
    expect(nextStep(state(), update({ stage: 'ready' }))).toEqual({ kind: 'restart', label: 'Restart to update' })
  })

  it('is to try again when the last attempt failed', () => {
    expect(nextStep(state(), update({ error: 'The download stopped.' }))).toEqual({ kind: 'download', label: 'Try again' })
    expect(nextStep(state(), update({ stage: 'ready', error: 'Cubex could not start the installer.' }))).toEqual({ kind: 'restart', label: 'Try again' })
  })

  it('is the release page for a copy or a release that Cubex cannot install', () => {
    expect(nextStep(state({ canInstall: false }), update())).toEqual({ kind: 'release', label: 'View release' })
    expect(nextStep(state(), update({}, { installer: undefined }))).toEqual({ kind: 'release', label: 'View release' })
    expect(nextStep(state({ canInstall: false }), update({ error: 'x' }))).toEqual({ kind: 'release', label: 'View release' })
  })

  it('is nothing while it is under way', () => {
    expect(nextStep(state(), update({ stage: 'downloading' }))).toEqual({ kind: 'none' })
    expect(nextStep(state(), update({ stage: 'installing' }))).toEqual({ kind: 'none' })
  })
})

describe('what "Later" puts off', () => {
  it('is one stage of one version, and an error to read counts as news', () => {
    expect(dismissalKey(update())).toBe('0.2.0:available')
    expect(dismissalKey(update({ stage: 'ready' }))).toBe('0.2.0:ready')
    expect(dismissalKey(update({ error: 'The download stopped.' }))).toBe('0.2.0:available:error')
    expect(dismissalKey(update({}, { version: '0.3.0' }))).toBe('0.3.0:available')
  })
})

describe('agoText', () => {
  const now = Date.parse('2026-10-21T12:00:00Z')
  it.each([
    [0, 'just now'], [30_000, 'just now'], [44_000, 'just now'], [45_000, '1 minute ago'], [90_000, '2 minutes ago'], [59 * 60_000, '59 minutes ago'],
    [60 * 60_000, '1 hour ago'], [5 * 3_600_000, '5 hours ago'], [23 * 3_600_000, '23 hours ago'], [24 * 3_600_000, '1 day ago'], [9 * 86_400_000, '9 days ago']
  ])('writes %i ms as %s', (ms, text) => {
    expect(agoText(now - ms, now)).toBe(text)
  })

  it('does not go negative when the clock moved', () => {
    expect(agoText(now + 60_000, now)).toBe('just now')
  })
})

describe('statusText', () => {
  const now = Date.parse('2026-10-21T12:00:00Z')

  it('is honest before anything was checked', () => {
    expect(statusText(state(), now)).toBe('Not checked yet.')
  })

  it('says when a look is under way', () => {
    expect(statusText(state({ check: { status: 'checking' } }), now)).toBe('Checking for updates…')
  })

  it('says Cubex is up to date, and since when', () => {
    expect(statusText(state({ check: { status: 'done', at: now - 5 * 60_000 } }), now)).toBe('Cubex is up to date. Checked 5 minutes ago.')
  })

  it('says what is on offer', () => {
    expect(statusText(state({ check: { status: 'done', at: now - 3_600_000 }, update: update() }), now)).toBe('Cubex 0.2.0 is available. Checked 1 hour ago.')
    expect(statusText(state({ check: { status: 'done', at: now }, update: update({ stage: 'ready' }) }), now)).toBe('Cubex 0.2.0 is downloaded and ready.')
    expect(statusText(state({ update: update() }), now)).toBe('Cubex 0.2.0 is available.')
  })

  it('says what a download and an install are doing', () => {
    expect(statusText(state({ update: update({ stage: 'downloading', progress: { received: 1_572_864, total: 89_484_330 } }) }), now)).toBe('Downloading Cubex 0.2.0.')
    expect(statusText(state({ update: update({ stage: 'installing' }) }), now)).toBe('Restarting to update.')
  })

  it('says that a look did not work, without hiding the last good one', () => {
    expect(statusText(state({ check: { status: 'failed', error: 'x' } }), now)).toBe('The last check did not work.')
    expect(statusText(state({ check: { status: 'failed', error: 'x', at: now - 2 * 3_600_000 } }), now)).toBe('The last check did not work. The last good check was 2 hours ago.')
  })
})

describe('busyText', () => {
  it.each([
    [{ turns: 1, tasks: 0 }, 'A session is still working. Updating now stops it.'],
    [{ turns: 3, tasks: 0 }, '3 sessions are still working. Updating now stops them.'],
    [{ turns: 0, tasks: 1 }, 'A background task is still working. Updating now stops it.'],
    [{ turns: 0, tasks: 4 }, '4 background tasks are still working. Updating now stops them.'],
    [{ turns: 1, tasks: 2 }, 'A session and 2 background tasks are still working. Updating now stops them.'],
    [{ turns: 2, tasks: 1 }, '2 sessions and a background task are still working. Updating now stops them.']
  ])('asks about %j', (busy, text) => {
    expect(busyText(busy)).toBe(text)
  })
})

describe('releaseDate', () => {
  it('writes the day a release was published, the same everywhere', () => {
    expect(releaseDate('2026-10-20T09:30:00.000Z')).toBe('October 20, 2026')
    expect(releaseDate('2026-10-20T23:59:00.000Z')).toBe('October 20, 2026')
  })

  it('leaves it out when there is none or it cannot be read', () => {
    expect(releaseDate(undefined)).toBe('')
    expect(releaseDate('')).toBe('')
    expect(releaseDate('someday')).toBe('')
  })
})
