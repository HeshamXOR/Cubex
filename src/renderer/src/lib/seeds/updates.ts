import type { UpdateInstallResult, UpdateState } from '../../../../shared/updates'
import type { PreviewSeed } from './index'

/**
 * Updates in the browser preview. The main process is replaced by a small simulation, so every state can be looked at.
 *   ?seed=1&done=1&update=available     a newer release is on offer; "Download update" runs a download of about six seconds
 *   ...&update=downloading              a download held at 47 percent
 *   ...&update=ready                    downloaded and checked; "Restart to update" would restart
 *   ...&update=error                    the last download failed
 *   ...&update=portable                 a copy that was not set up by the installer: it links to the release page
 *   ...&update=noinstaller              a release without a checksum, which Cubex will not install
 *   ...&update=skipped                  a version the person skipped: not announced, still on the Settings page
 *   ...&update=uptodate                 a look that found nothing
 *   ...&update=checking                 a look that is under way
 *   ...&update=failed                   a look that could not reach GitHub
 *   ...&update=long                     release notes that need to scroll
 *   ...&update=cut                      release notes that were cut at the limit
 *   ...&update=empty                    a release without notes
 *   ...&update=none                     nothing checked yet
 * Add `busy=1` for a restart that is refused because work is running. `window.__updates` drives the simulation from a
 * script: `set(mode)` jumps to a state, `push(state)` sends any state.
 */

const NOTES = `### Added

- **Other agents.** Ask Claude Code, Antigravity or another model to weigh in on a question and settle it with you. Switch an agent on for a session from the **+** menu in the composer. Every consult asks for your approval first.
- **Updates.** Cubex now tells you when a new version is out and shows what changed. It downloads the installer, checks it against the checksum GitHub publishes, and restarts into it when you press **Restart to update**.

### Changed

- **Settings are pages.** General, Appearance, Models, Tools, Permissions, Other agents, Privacy, Updates and About each have their own page. \`Ctrl+K\` finds a page by what is on it.
- **Switches are neutral.** The on and off switches use the same quiet palette as the rest of the window, not a color of their own.

### Fixed

- A long answer no longer jumps while it is still being written.
- Closing the window during a download of a local model keeps what has arrived.`

const LONG_NOTES = `${NOTES}\n\n${Array.from({ length: 4 }, (_, index) => `### Earlier work ${index + 1}\n\n- A change from the ${['first', 'second', 'third', 'fourth'][index]} round that still deserves a line, written the way a person would write it.\n- Another change in the same round, long enough that the line has to wrap inside the dialog so wrapping can be reviewed too.\n- A third change with \`inline code\` and a [link to the repository](https://github.com/HeshamXOR/Cubex).`).join('\n\n')}`

const SIZE = 89_484_330

type Mode = 'available' | 'downloading' | 'ready' | 'error' | 'portable' | 'noinstaller' | 'skipped' | 'uptodate' | 'checking' | 'failed' | 'long' | 'cut' | 'empty' | 'none'
const MODES: readonly string[] = ['available', 'downloading', 'ready', 'error', 'portable', 'noinstaller', 'skipped', 'uptodate', 'checking', 'failed', 'long', 'cut', 'empty', 'none']

function stateFor(mode: Mode): UpdateState {
  const base: UpdateState = { currentVersion: '0.1.0', canInstall: true, check: { status: 'done', at: Date.now() - 4 * 60_000 } }
  const release = (extra: Partial<NonNullable<UpdateState['update']>['info']> = {}): NonNullable<UpdateState['update']>['info'] => ({
    version: '0.2.0',
    name: 'Cubex 0.2.0',
    notes: NOTES,
    publishedAt: '2026-10-20T09:30:00.000Z',
    pageUrl: 'https://github.com/HeshamXOR/Cubex/releases/tag/v0.2.0',
    installer: { name: 'Cubex-Setup-0.2.0.exe', size: SIZE },
    ...extra
  })
  switch (mode) {
    case 'none': return { ...base, check: { status: 'idle' } }
    case 'uptodate': return base
    case 'checking': return { ...base, check: { status: 'checking', at: base.check.at as number } }
    case 'failed': return { ...base, check: { status: 'failed', at: base.check.at as number, error: 'Cubex could not reach GitHub. Check your connection and try again.' } }
    case 'available': return { ...base, update: { info: release(), stage: 'available' } }
    case 'long': return { ...base, update: { info: release({ notes: LONG_NOTES }), stage: 'available' } }
    case 'cut': return { ...base, update: { info: release({ notes: LONG_NOTES, notesCut: true }), stage: 'available' } }
    case 'empty': return { ...base, update: { info: release({ notes: '' }), stage: 'available' } }
    case 'downloading': return { ...base, update: { info: release(), stage: 'downloading', progress: { received: Math.round(SIZE * 0.47), total: SIZE } } }
    case 'ready': return { ...base, update: { info: release(), stage: 'ready' } }
    case 'error': return { ...base, update: { info: release(), stage: 'available', error: 'The download stopped before it finished. Check your connection and try again.' } }
    case 'skipped': return { ...base, update: { info: release(), stage: 'available', skipped: true } }
    case 'portable':
      return {
        ...base,
        canInstall: false,
        cannotInstallReason: 'This copy was not set up with the Cubex installer, so it cannot update itself. Download the installer from the release page.',
        update: { info: release(), stage: 'available' }
      }
    case 'noinstaller':
      return {
        ...base,
        update: { info: release({ installer: undefined, installerProblem: 'This release has no checksum, so Cubex will not install it for you. Download it from the release page.' }), stage: 'available' }
      }
  }
}

export const seed: PreviewSeed = {
  api: (flags) => {
    const flag = flags.get('update')
    if (flag === null || !MODES.includes(flag)) return {}
    const listeners = new Set<(state: UpdateState) => void>()
    let state = stateFor(flag as Mode)
    let timer: number | undefined
    const push = (next: UpdateState): UpdateState => {
      state = next
      listeners.forEach((listener) => listener(state))
      return state
    }
    const stop = (): void => {
      window.clearInterval(timer)
      timer = undefined
    }
    ;(window as unknown as { __updates: unknown }).__updates = {
      set: (mode: Mode) => { stop(); return push(stateFor(mode)) },
      push: (next: UpdateState) => { stop(); return push(next) }
    }
    const opened: string[] = []
    ;(window as unknown as { __openedUpdatePages: string[] }).__openedUpdatePages = opened
    return {
      getUpdateState: async () => state,
      onUpdateState: (cb) => {
        listeners.add(cb)
        return () => { listeners.delete(cb) }
      },
      checkForUpdates: async () => {
        stop()
        const known = state
        push({ ...known, check: { status: 'checking', ...(known.check.at !== undefined ? { at: known.check.at } : {}) } })
        await new Promise((resolve) => setTimeout(resolve, 1400))
        return push({ ...known, check: { status: 'done', at: Date.now() } })
      },
      downloadUpdate: async () => {
        const update = state.update
        if (!update || update.stage !== 'available') return state
        const total = update.info.installer?.size ?? SIZE
        let received = 0
        const next = push({ ...state, update: { info: update.info, stage: 'downloading', progress: { received, total } } })
        timer = window.setInterval(() => {
          received = Math.min(total, received + Math.round(total / 60))
          const current = state.update
          if (!current) return
          if (received >= total) {
            stop()
            push({ ...state, update: { info: current.info, stage: 'ready' } })
          } else push({ ...state, update: { ...current, stage: 'downloading', progress: { received, total } } })
        }, 100)
        return next
      },
      cancelUpdateDownload: async () => {
        stop()
        const update = state.update
        return update ? push({ ...state, update: { info: update.info, stage: 'available' } }) : state
      },
      installUpdate: async (request): Promise<UpdateInstallResult> => {
        const update = state.update
        if (!update || update.stage !== 'ready') return { ok: false, reason: 'failed', message: 'There is no downloaded update to install. Download it first.' }
        if (flags.get('busy') === '1' && !request?.force) return { ok: false, reason: 'busy', busy: { turns: 1, tasks: 2 } }
        push({ ...state, update: { info: update.info, stage: 'installing' } })
        return { ok: true }
      },
      skipUpdate: async () => {
        const update = state.update
        return update ? push({ ...state, update: { ...update, skipped: true } }) : state
      },
      openUpdatePage: async () => { opened.push(state.update?.info.pageUrl ?? 'https://github.com/HeshamXOR/Cubex/releases') }
    }
  }
}
