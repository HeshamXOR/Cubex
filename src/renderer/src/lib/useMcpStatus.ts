import { useCallback, useEffect, useState } from 'react'
import type { McpServerStatus } from '../../../shared/policy'
import { api } from './api'

/** How often the page re-reads the servers while it is open. Servers connect when a session starts, so the state changes under it. */
const REFRESH_MS = 4_000

interface McpStatusState {
  byId: ReadonlyMap<string, McpServerStatus>
  /** True until the first answer. */
  loading: boolean
  error?: string
  reload: () => void
}

/** Live state of the saved MCP servers. `signature` changes whenever the saved list does, which re-reads at once. */
export function useMcpStatus(signature: string): McpStatusState {
  const [byId, setById] = useState<ReadonlyMap<string, McpServerStatus>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let current = true
    const read = (): void => {
      if (document.visibilityState === 'hidden') return
      void api.getMcpStatus().then(
        (statuses) => {
          if (!current) return
          setById(new Map(statuses.map((status) => [status.id, status])))
          setError(undefined)
          setLoading(false)
        },
        (reason: unknown) => {
          if (!current) return
          setError(reason instanceof Error ? reason.message : String(reason))
          setLoading(false)
        }
      )
    }
    read()
    const timer = window.setInterval(read, REFRESH_MS)
    return () => {
      current = false
      window.clearInterval(timer)
    }
  }, [signature, revision])

  const reload = useCallback(() => setRevision((value) => value + 1), [])
  return { byId, loading, error, reload }
}
