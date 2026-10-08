import { DEFAULT_RETRY_POLICY } from '@core/types'
import type { ChatStartRequest } from '../../../shared/ipc'
import { useStore } from '../state/store'

/**
 * What a turn for review comments runs with, taken from what the composer shows so the model, the thinking effort and the
 * mode are the ones the person sees. Without a chosen model it is left to the main process, which uses the task's last turn.
 */
export function reviewRequest(): Partial<ChatStartRequest> | undefined {
  const state = useStore.getState()
  if (!state.activeProviderId || !state.activeModel) return undefined
  return {
    policy: {
      primary: {
        providerId: state.activeProviderId,
        model: state.activeModel,
        params: { ...(state.maxTokens > 0 ? { maxOutputTokens: state.maxTokens } : {}), ...(state.effort ? { reasoningEffort: state.effort } : {}) }
      },
      fallbacks: [],
      fallbackEnabled: false,
      retry: DEFAULT_RETRY_POLICY,
      timeout: {}
    },
    // Plan mode left on from planning would refuse the edits the comments ask for, so the main process chooses the mode then.
    ...(state.permissionMode !== 'plan' ? { permissionMode: state.permissionMode } : {}),
    longContext: state.longContext,
    peers: state.peers
  }
}
