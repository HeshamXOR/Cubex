import { useEffect, useState } from 'react'
import { api } from './api'
import { useStore } from '../state/store'
import { activitySpecFor } from '../status/StatusIndicator'
import type { WorkspaceGitStatus } from '../../../shared/ipc'

const REFRESH_EVENT = 'cubex:git-refresh'

/** Tell every git readout to look again, for when something here (a commit) changed the repository. */
export function refreshGitStatus(): void {
  window.dispatchEvent(new Event(REFRESH_EVENT))
}

/**
 * Read-only git facts for the open conversation's project, refreshed when the
 * conversation changes, when a turn ends (edits may have changed the tree), when
 * the window regains focus and on refreshGitStatus. Null when there is no project.
 */
export function useGitStatus(conversationId: string | undefined): WorkspaceGitStatus | null | undefined {
  const [status, setStatus] = useState<{ owner?: string; value: WorkspaceGitStatus | null }>()
  const busy = useStore((state) => !!activitySpecFor(state.status).active)
  const workspace = useStore((state) => state.activeConversation?.workspacePath ?? state.settings?.general.workspacePath)

  useEffect(() => {
    let alive = true
    const load = (): void => {
      api.getGitStatus(conversationId).then(
        (value) => { if (alive) setStatus({ owner: conversationId, value }) },
        () => { if (alive) setStatus({ owner: conversationId, value: null }) }
      )
    }
    if (busy) return
    load()
    window.addEventListener('focus', load)
    window.addEventListener(REFRESH_EVENT, load)
    return () => {
      alive = false
      window.removeEventListener('focus', load)
      window.removeEventListener(REFRESH_EVENT, load)
    }
  }, [conversationId, workspace, busy])

  return status && status.owner === conversationId ? status.value : undefined
}
