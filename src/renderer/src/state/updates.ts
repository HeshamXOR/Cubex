import { create } from 'zustand'
import type { UpdateBusy, UpdateState } from '../../../shared/updates'
import { initialUpdateState } from '../../../shared/updates'
import { api } from '../lib/api'
import { dismissalKey, type NextStep, type Update } from '../lib/updateText'

type Step = 'check' | 'download' | 'cancel' | 'install' | 'skip'

interface UpdatesState {
  /** What the main process last said. It owns this and pushes every change; nothing here is polled. */
  state: UpdateState
  /** The main process has answered at least once. */
  loaded: boolean
  /** The dialog with the release notes is open. */
  dialogOpen: boolean
  /** The stage of an update that the person put off with "Later" (`dismissalKey`). Forgotten when Cubex restarts. */
  dismissed: string | undefined
  /** Work that restarting would stop. Set when an install was asked for and refused, so the window can ask. */
  busy: UpdateBusy | undefined
  /** A step that failed without the main process putting it into the state, in a sentence. */
  problem: string | undefined
  /** A request is on its way, so its button shows that. */
  pending: Step | undefined

  /** Listens for pushes and reads the first state. Returns the way to stop. */
  start: () => () => void
  check: () => Promise<void>
  download: () => Promise<void>
  cancelDownload: () => Promise<void>
  /** Restart and install. Without `force`, running work makes this ask first (`busy`). */
  install: (force?: boolean) => Promise<void>
  skip: () => Promise<void>
  openPage: () => Promise<void>
  dismiss: () => void
  openDialog: () => void
  closeDialog: () => void
  /** The person decided to wait for running work to finish. */
  waitForWork: () => void
}

const reason = (error: unknown): string => (error instanceof Error && error.message ? error.message : 'Something went wrong. Try again.')

export const useUpdates = create<UpdatesState>((set, get) => {
  /** Runs one request: marks it as pending, takes the state it answers with, and keeps a failure to say. */
  const run = async (step: Step, request: () => Promise<UpdateState>): Promise<void> => {
    set({ pending: step, problem: undefined })
    try {
      set({ state: await request(), loaded: true })
    } catch (error) {
      set({ problem: reason(error) })
    } finally {
      set({ pending: undefined })
    }
  }

  return {
    state: initialUpdateState(''),
    loaded: false,
    dialogOpen: false,
    dismissed: undefined,
    busy: undefined,
    problem: undefined,
    pending: undefined,

    start: () => {
      let alive = true
      let pushed = false
      const stop = api.onUpdateState((next) => {
        pushed = true
        set({ state: next, loaded: true })
      })
      // A push is newer than the first read, so the read only fills in when nothing was pushed yet.
      api.getUpdateState().then(
        (first) => { if (alive && !pushed) set({ state: first, loaded: true }) },
        () => { if (alive) set({ loaded: true }) }
      )
      return () => {
        alive = false
        stop()
      }
    },

    check: () => run('check', () => api.checkForUpdates()),
    download: () => run('download', () => api.downloadUpdate()),
    cancelDownload: () => run('cancel', () => api.cancelUpdateDownload()),

    install: async (force = false) => {
      set({ pending: 'install', problem: undefined, busy: undefined })
      try {
        const result = await api.installUpdate(force ? { force: true } : undefined)
        if (!result.ok) {
          if (result.reason === 'busy') set({ busy: result.busy })
          else set({ problem: result.message })
        }
      } catch (error) {
        set({ problem: reason(error) })
      } finally {
        set({ pending: undefined })
      }
    },

    skip: async () => {
      const update = get().state.update
      if (!update) return
      await run('skip', () => api.skipUpdate(update.info.version))
      if (!get().problem) set({ dialogOpen: false })
    },

    openPage: async () => {
      try {
        await api.openUpdatePage()
      } catch (error) {
        set({ problem: reason(error) })
      }
    },

    dismiss: () => {
      const update = get().state.update
      set({ dialogOpen: false, busy: undefined, ...(update ? { dismissed: dismissalKey(update) } : {}) })
    },
    openDialog: () => set({ dialogOpen: true, problem: undefined }),
    closeDialog: () => set({ dialogOpen: false, busy: undefined }),
    waitForWork: () => set({ busy: undefined })
  }
})

/** The update the sidebar announces: one the person has neither skipped nor put off. */
export function announcedUpdate(store: Pick<UpdatesState, 'state' | 'dismissed'>): Update | undefined {
  const { update } = store.state
  return update && !update.skipped && store.dismissed !== dismissalKey(update) ? update : undefined
}

/** An update the person put off: it stays reachable from a quiet link, not a card. */
export function putOffUpdate(store: Pick<UpdatesState, 'state' | 'dismissed'>): Update | undefined {
  const { update } = store.state
  return update && !update.skipped && store.dismissed === dismissalKey(update) ? update : undefined
}

/** Takes the step a button names: downloads, restarts, or opens the release page. */
export function useStepRunner(): (step: NextStep) => void {
  const download = useUpdates((store) => store.download)
  const install = useUpdates((store) => store.install)
  const openPage = useUpdates((store) => store.openPage)
  return (step) => {
    if (step.kind === 'download') void download()
    else if (step.kind === 'restart') void install()
    else if (step.kind === 'release') void openPage()
  }
}
