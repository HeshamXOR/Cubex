import { create } from 'zustand'
import type { ValidationResult } from '@core/types'
import type { ModelRefreshResult } from '../../../shared/ipc'
import { api } from '../lib/api'
import { plainError } from '../lib/localModels'

/** What the note under a provider row reports: the latest connection test or model refresh. */
export type ProviderNotice = { kind: 'test'; result: ValidationResult } | { kind: 'refresh'; refresh: ModelRefreshResult }

interface ProviderChecks {
  /** The last connection test per provider, which is where a row's state comes from. */
  tests: Record<string, ValidationResult>
  notices: Record<string, ProviderNotice>
  testing: Record<string, true>
  refreshing: Record<string, true>
  test: (providerId: string) => Promise<ValidationResult | undefined>
  refresh: (providerId: string) => Promise<ModelRefreshResult | undefined>
  /** The configuration changed or went away: what was learned about it no longer holds, and answers still in flight are dropped. */
  forget: (providerId: string) => void
  dismiss: (providerId: string) => void
}

const generations = new Map<string, number>()
const generation = (id: string): number => generations.get(id) ?? 0

function without<T>(record: Record<string, T>, id: string): Record<string, T> {
  const { [id]: _removed, ...rest } = record
  return rest
}

/**
 * Connection tests and model refreshes live here rather than in the Providers view, so what a test
 * found is still on the row after the person visits another view and comes back.
 */
export const useProviderChecks = create<ProviderChecks>((set, get) => ({
  tests: {},
  notices: {},
  testing: {},
  refreshing: {},

  test: async (providerId) => {
    if (get().testing[providerId]) return undefined
    const started = generation(providerId)
    set((s) => ({ testing: { ...s.testing, [providerId]: true }, tests: without(s.tests, providerId), notices: without(s.notices, providerId) }))
    let result: ValidationResult
    try {
      result = await api.testProvider(providerId)
    } catch (err) {
      result = { ok: false, message: plainError(err) }
    }
    const stale = started !== generation(providerId)
    set((s) => ({
      testing: without(s.testing, providerId),
      ...(stale ? {} : { tests: { ...s.tests, [providerId]: result }, notices: { ...s.notices, [providerId]: { kind: 'test' as const, result } } })
    }))
    return stale ? undefined : result
  },

  refresh: async (providerId) => {
    if (get().refreshing[providerId]) return undefined
    const started = generation(providerId)
    set((s) => ({ refreshing: { ...s.refreshing, [providerId]: true } }))
    let refresh: ModelRefreshResult
    try {
      refresh = await api.refreshModels(providerId)
    } catch (err) {
      refresh = { ok: false, count: 0, message: plainError(err) }
    }
    const stale = started !== generation(providerId)
    set((s) => ({
      refreshing: without(s.refreshing, providerId),
      ...(stale ? {} : { notices: { ...s.notices, [providerId]: { kind: 'refresh' as const, refresh } } })
    }))
    return stale ? undefined : refresh
  },

  forget: (providerId) => {
    generations.set(providerId, generation(providerId) + 1)
    set((s) => ({
      tests: without(s.tests, providerId),
      notices: without(s.notices, providerId),
      testing: without(s.testing, providerId),
      refreshing: without(s.refreshing, providerId)
    }))
  },

  dismiss: (providerId) => set((s) => ({ notices: without(s.notices, providerId) }))
}))
