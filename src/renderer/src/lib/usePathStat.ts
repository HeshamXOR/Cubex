import { useEffect, useState } from 'react'
import { api } from './api'
import { PathChecker } from './pathChecker'
import { useStore } from '../state/store'
import type { WorkspacePathStat } from '../../../shared/workspaceFile'

const checker = new PathChecker({ stat: (paths, conversationId) => api.statWorkspacePaths(paths, conversationId) })

/**
 * Whether a path from the conversation exists in the open task's workspace: undefined while the main
 * process is being asked, then the canonical path to open or `missing`. Answers are shared and cached.
 */
export function usePathStat(path: string | undefined): WorkspacePathStat | undefined {
  const conversationId = useStore((state) => state.activeConversation?.id)
  const workspace = useStore((state) => (state.activeConversation ? state.activeConversation.workspacePath : state.settings?.general.workspacePath))
  const scope = workspace ? `${workspace}\0${conversationId ?? ''}` : undefined
  const [stat, setStat] = useState<WorkspacePathStat | undefined>(() => (path && scope ? checker.peek(scope, path) : undefined))

  useEffect(() => {
    if (!path || !scope) {
      setStat(undefined)
      return
    }
    const known = checker.peek(scope, path)
    setStat(known)
    if (known) return
    let live = true
    void checker.check(scope, conversationId, path).then((answer) => { if (live) setStat(answer) })
    return () => { live = false }
  }, [path, scope, conversationId])

  return stat
}
