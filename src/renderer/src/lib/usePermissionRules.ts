import { useCallback, useEffect, useState } from 'react'
import type { PermissionRule } from '../../../shared/ipc'
import { api } from './api'

interface PermissionRulesState {
  rules: PermissionRule[]
  /** Ids of the rules that belong to the selected project, as main decides it. */
  currentIds: ReadonlySet<string>
  /** True until the first answer; later refreshes keep showing the old list. */
  loading: boolean
  error?: string
  reload: () => void
  /** Delete these rules, then refresh. Resolves to an error message when it failed. */
  remove: (ids: readonly string[]) => Promise<string | undefined>
}

const messageOf = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason))

/** Saved "Always allow" rules, all projects, plus which of them belong to `workspace`. */
export function usePermissionRules(workspace: string | undefined): PermissionRulesState {
  const [rules, setRules] = useState<PermissionRule[]>([])
  const [currentIds, setCurrentIds] = useState<ReadonlySet<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let current = true
    void Promise.all([api.listPermissionRules(), workspace ? api.listPermissionRules(workspace) : Promise.resolve([])]).then(
      ([all, mine]) => {
        if (!current) return
        setRules(all)
        setCurrentIds(new Set(mine.map((rule) => rule.id)))
        setError(undefined)
        setLoading(false)
      },
      (reason: unknown) => {
        if (!current) return
        setError(messageOf(reason))
        setLoading(false)
      }
    )
    return () => { current = false }
  }, [workspace, revision])

  const reload = useCallback(() => setRevision((value) => value + 1), [])
  const remove = useCallback(async (ids: readonly string[]): Promise<string | undefined> => {
    try {
      for (const id of ids) await api.removePermissionRule(id)
      return undefined
    } catch (reason) {
      return messageOf(reason)
    } finally {
      reload()
    }
  }, [reload])

  return { rules, currentIds, loading, error, reload, remove }
}
