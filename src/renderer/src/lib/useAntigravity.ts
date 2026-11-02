import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AntigravityActionResult, AntigravityStatus } from '../../../shared/antigravity'
import type { AntigravityAction } from './antigravityRows'
import { api } from './api'

export interface AntigravityState {
  /** The last answer. Undefined until the first one arrives. */
  status: AntigravityStatus | undefined
  error?: string
  /** What the last request came to, when Cubex refused it: a sentence with the reason and what to do. */
  refusal: AntigravityActionResult | undefined
  /** A request has been sent and not answered yet. */
  pending: boolean
  run: (action: AntigravityAction) => void
  hideRefusal: () => void
  reload: () => void
}

function request(action: AntigravityAction, status: AntigravityStatus): Promise<AntigravityActionResult> {
  switch (action) {
    case 'install': return api.installAntigravity()
    case 'cancel-install':
      return status.runtime.operationId ? api.cancelAntigravityInstall(status.runtime.operationId) : Promise.resolve({ ok: false, message: 'There is no installation to cancel.' })
    case 'sign-in': return api.signInAntigravity()
    case 'cancel-sign-in':
      return status.signIn.flowId ? api.cancelAntigravitySignIn(status.signIn.flowId) : Promise.resolve({ ok: false, message: 'There is no sign-in to cancel.' })
    case 'open-page': return api.openAntigravitySignIn()
    case 'sign-out': return api.signOutAntigravity()
    case 'remove': return api.removeAntigravity()
  }
}

/**
 * What is installed of Google's Antigravity runtime, who is signed in, and the actions on it. The main process pushes every change of an
 * install or a sign-in, so the page follows a download as it goes. It is read again when the window comes back to the front, since the
 * desktop app can be installed or removed in the meantime.
 */
export function useAntigravity(): AntigravityState {
  const [status, setStatus] = useState<AntigravityStatus>()
  const [error, setError] = useState<string>()
  const [refusal, setRefusal] = useState<AntigravityActionResult>()
  const [pending, setPending] = useState(false)
  const latest = useRef(status)
  latest.current = status
  const mounted = useRef(true)

  const reload = useCallback((): void => {
    api.getAntigravityStatus().then(
      (value) => { if (mounted.current) { setStatus(value); setError(undefined) } },
      (reason: unknown) => { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    )
  }, [])

  useEffect(() => {
    mounted.current = true
    reload()
    const stop = api.onAntigravityState((next) => { if (mounted.current) { setStatus(next); setError(undefined) } })
    window.addEventListener('focus', reload)
    return () => {
      mounted.current = false
      stop()
      window.removeEventListener('focus', reload)
    }
  }, [reload])

  const run = useCallback((action: AntigravityAction): void => {
    const current = latest.current
    if (!current) return
    setPending(true)
    setRefusal(undefined)
    request(action, current).then(
      (result) => { if (mounted.current && !result.ok) setRefusal(result) },
      (reason: unknown) => { if (mounted.current) setRefusal({ ok: false, message: reason instanceof Error ? reason.message : String(reason) }) }
    ).finally(() => {
      if (!mounted.current) return
      setPending(false)
      // A push normally has said it already; asking again is cheap and settles a push that was missed.
      reload()
    })
  }, [reload])

  const hideRefusal = useCallback(() => setRefusal(undefined), [])
  return useMemo(() => ({ status, ...(error ? { error } : {}), refusal, pending, run, hideRefusal, reload }), [status, error, refusal, pending, run, hideRefusal, reload])
}
