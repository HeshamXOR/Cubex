import { create } from 'zustand'
import { api } from '../lib/api'
import { plainError } from '../lib/localModels'
import { isModelName, MODEL_NAME_HINT } from '../../../shared/modelName'
import { applyPullEvent, failedPull, pullKey, startingPull, type Pull, type PullsSnapshot } from './pullModel'

interface PullsStore extends PullsSnapshot {
  /** Ask a runtime for a model. It joins the line if another download is running. */
  start: (runtime: string, modelId: string) => Promise<void>
  cancel: (pull: Pull) => void
  /** Remove a failed download's message. */
  dismiss: (pull: Pull) => void
}

/**
 * Downloads live here rather than in the Local models view, so leaving the view does not forget
 * what is running or waiting. The feed starts when this module loads, which is at app start.
 */
export const usePulls = create<PullsStore>((set, get) => ({
  pulls: {},
  finished: 0,

  start: async (runtime, modelId) => {
    const name = modelId.trim()
    const key = pullKey({ runtime, modelId: name })
    if (!isModelName(name)) {
      set((s) => ({ pulls: { ...s.pulls, [key]: failedPull(runtime, name, MODEL_NAME_HINT) } }))
      return
    }
    const current = get().pulls[key]
    if (current && !current.error) return
    set((s) => ({ pulls: { ...s.pulls, [key]: startingPull(runtime, name) } }))
    try {
      const { pullId } = await api.pullModel({ runtime, modelId: name })
      // Progress events carry the id too; this only lets Cancel work if none has arrived yet.
      set((s) => {
        const row = s.pulls[key]
        return row && row.pullId === '' && !row.done ? { pulls: { ...s.pulls, [key]: { ...row, pullId } } } : s
      })
    } catch (err) {
      set((s) => ({ pulls: { ...s.pulls, [key]: failedPull(runtime, name, plainError(err)) } }))
    }
  },

  cancel: (pull) => {
    if (pull.pullId) void api.cancelPull(pull.pullId).catch(() => undefined)
  },

  dismiss: (pull) =>
    set((s) => {
      const { [pullKey(pull)]: _dismissed, ...rest } = s.pulls
      return { pulls: rest }
    })
}))

api.onPullProgress((event) => usePulls.setState((s) => applyPullEvent(s, event)))
