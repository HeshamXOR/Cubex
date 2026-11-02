import type { ContextUsageSnapshot } from '../../../shared/ipc'

/**
 * Whether a snapshot was taken for a different model than the one selected now, as when a task is opened after its
 * model was changed. Its window and input budget then describe the other model, so the meter uses the selected
 * model's window instead. Another name for a window of the same size (a dated model id, say) changes nothing.
 */
export function snapshotIsForOtherModel(
  usage: ContextUsageSnapshot | undefined,
  selected: { providerId?: string; model?: string },
  selectedWindow: number | undefined
): boolean {
  if (!usage?.model || !selected.model) return false
  const sameModel = usage.model === selected.model && (!usage.provider || !selected.providerId || usage.provider === selected.providerId)
  return !sameModel && usage.contextWindow !== selectedWindow
}
