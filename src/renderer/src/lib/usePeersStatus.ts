import { useCallback, useEffect, useState } from 'react'
import type { PeerPresetId, PeerPresetStatus, PeerStatus } from '../../../shared/peers'
import { api } from './api'

interface PeersStatusState {
  byId: ReadonlyMap<string, PeerStatus>
  presets: ReadonlyMap<PeerPresetId, PeerPresetStatus>
  /** Local-only mode is on: programs are not started. */
  localOnly: boolean
  /** True until the first answer. */
  loading: boolean
  error?: string
  reload: () => void
}

/**
 * Which saved agents can be used on this computer. `signature` changes whenever the saved list does, which re-reads at
 * once. The answer is read again when the window comes back to the front, since the likely reason to leave is to
 * install a program and the page should notice without a restart.
 */
export function usePeersStatus(signature: string): PeersStatusState {
  const [byId, setById] = useState<ReadonlyMap<string, PeerStatus>>(new Map())
  const [presets, setPresets] = useState<ReadonlyMap<PeerPresetId, PeerPresetStatus>>(new Map())
  const [localOnly, setLocalOnly] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let current = true
    const read = (): void => {
      void api.getPeersStatus().then(
        (overview) => {
          if (!current) return
          setById(new Map(overview.peers.map((status) => [status.id, status])))
          setPresets(new Map(overview.presets.map((status) => [status.preset, status])))
          setLocalOnly(overview.localOnly)
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
    window.addEventListener('focus', read)
    return () => {
      current = false
      window.removeEventListener('focus', read)
    }
  }, [signature, revision])

  const reload = useCallback(() => setRevision((value) => value + 1), [])
  return { byId, presets, localOnly, loading, error, reload }
}
