import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentDetection, AgentsDetection } from '../../../shared/agentCatalog'
import { api } from './api'

export interface AgentsDetectionState {
  /** The last answer. It stays on screen while a newer look is under way. */
  detection: AgentsDetection | undefined
  byId: ReadonlyMap<string, AgentDetection>
  /** A look the person is waiting for is under way: the first one, or "Check again". */
  checking: boolean
  error?: string
  /** Look again now. Every program that is on this computer is started, so it takes a few seconds. */
  recheck: () => void
  /** The person did something outside this window, such as start a sign-in: look again when they come back. */
  expectChange: () => void
}

/**
 * Which coding agents are on this computer, with their version and who is signed in. The main process keeps an answer for
 * a couple of minutes, so reading it when the window comes back to the front is cheap, and it is read again on a
 * sign-in or an install since those are the likely reasons to have left.
 */
export function useAgentsDetection(): AgentsDetectionState {
  const [detection, setDetection] = useState<AgentsDetection>()
  const [checking, setChecking] = useState(true)
  const [error, setError] = useState<string>()
  const latest = useRef(0)
  const mounted = useRef(true)
  const stale = useRef(false)

  // `visible`: the person is waiting for this one, so the page says it is checking. A quiet read keeps the answer as it is.
  const read = useCallback((refresh: boolean, visible: boolean): void => {
    const mine = ++latest.current
    if (visible) setChecking(true)
    api.detectAgents(refresh).then(
      (value) => {
        if (!mounted.current || latest.current !== mine) return
        setDetection(value)
        setError(undefined)
        setChecking(false)
      },
      (reason: unknown) => {
        if (!mounted.current || latest.current !== mine) return
        setError(reason instanceof Error ? reason.message : String(reason))
        setChecking(false)
      }
    )
  }, [])

  useEffect(() => {
    mounted.current = true
    read(false, true)
    const onFocus = (): void => {
      const refresh = stale.current
      stale.current = false
      read(refresh, refresh)
    }
    window.addEventListener('focus', onFocus)
    return () => {
      mounted.current = false
      window.removeEventListener('focus', onFocus)
    }
  }, [read])

  const recheck = useCallback(() => read(true, true), [read])
  const expectChange = useCallback(() => { stale.current = true }, [])
  const byId = useMemo(() => new Map((detection?.agents ?? []).map((agent) => [agent.id, agent] as const)), [detection])
  return { detection, byId, checking, ...(error ? { error } : {}), recheck, expectChange }
}
