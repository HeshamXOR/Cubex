import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dataDir } from './paths'
import type { Capability, ReasoningEffort } from '@core/types'

/**
 * Model catalog synchronization.
 *
 * models.dev Sync:
 *    Fetches https://models.dev/api.json at most once every 6 hours with ETag caching.
 *    Caches a trimmed copy to disk in userData/cubex-data/models-dev-catalog.json.
 *    Precedence: what a provider reports about its own models > the catalog > nothing. The catalog only fills gaps:
 *    a compatible endpoint lists model ids and little else, so context windows, prices and the effort levels a
 *    reasoning model takes come from here.
 *
 * The request carries nothing about the user. Local-only mode never calls it (see `ProviderManager`).
 * Spending caps are not evaluated here: `budget.ts` enforces them before each request.
 */

export const MODELS_DEV_URL = 'https://models.dev/api.json'
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000 // 6 hours
/** A refresh must not hang the catalog: models.dev is optional, the builtin list is not. */
export const CATALOG_FETCH_TIMEOUT_MS = 15_000

export interface CatalogModelPricing {
  inputPerMTok: number
  outputPerMTok: number
  cachedInputPerMTok?: number
  cacheWritePerMTok?: number
  currency: string
  source: 'catalog'
}

export interface CatalogModel {
  id: string
  providerId: string
  displayName: string
  family?: string
  /** Absent when the catalog does not say: an unknown window must not be shown as a made-up one. */
  contextWindow?: number
  maxInputTokens?: number
  maxOutputTokens?: number
  supportsTools: boolean
  supportsReasoning: boolean
  supportsAttachments: boolean
  /**
   * The effort levels the model takes, lowest first. An empty list is a model that reasons but has no effort
   * setting (it may only have an on and off switch). Absent when the catalog says nothing about it.
   */
  reasoningEfforts?: ReasoningEffort[]
  /** Absent when the catalog has no price, which is not the same as free. A free model is priced at zero. */
  pricing?: CatalogModelPricing
  capabilities: Capability[]
}

export interface CatalogStatus {
  updatedAt?: number
  source: 'catalog' | 'builtin'
  models: number
}

export interface CatalogRefreshResult {
  ok: boolean
  error?: string
}

export interface ModelCatalogOptions {
  fetch?: typeof fetch
  now?: () => number
  cachePath?: string
  url?: string
}

interface DiskCache {
  etag?: string
  updatedAt: number
  raw?: unknown
}

/** The efforts a catalog entry can name that Cubex has a level for. "none" turns reasoning off and is not a level. */
const EFFORT_ORDER: readonly ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** What `reasoning_options` says about effort: the levels, an empty list when there is no effort setting, or nothing. */
function effortsOf(options: unknown): ReasoningEffort[] | undefined {
  if (!Array.isArray(options)) return undefined
  const effort = options.find((option) => option && typeof option === 'object' && (option as { type?: unknown }).type === 'effort')
  const values = (effort as { values?: unknown } | undefined)?.values
  if (!Array.isArray(values)) return []
  return EFFORT_ORDER.filter((level) => values.includes(level))
}

const positive = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined)

/** Only the fields Cubex reads, so the copy kept on disk is a fraction of the full catalog. */
function trimCatalog(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data
  const out: Record<string, unknown> = {}
  for (const [providerKey, providerRaw] of Object.entries(data as Record<string, any>)) {
    if (!providerRaw || typeof providerRaw !== 'object' || !providerRaw.models || typeof providerRaw.models !== 'object') continue
    const models: Record<string, unknown> = {}
    for (const [modelKey, m] of Object.entries(providerRaw.models as Record<string, any>)) {
      if (!m || typeof m !== 'object') continue
      const cost = m.cost && typeof m.cost === 'object' ? { input: m.cost.input, output: m.cost.output, cache_read: m.cost.cache_read, cache_write: m.cost.cache_write } : undefined
      models[modelKey] = {
        id: m.id, name: m.name, family: m.family, reasoning: m.reasoning, reasoning_options: m.reasoning_options,
        tool_call: m.tool_call, attachment: m.attachment, limit: m.limit, ...(cost ? { cost } : {})
      }
    }
    out[providerKey] = { id: providerRaw.id, api: providerRaw.api, models }
  }
  return out
}

export class ModelCatalog {
  private readonly fetchImpl: typeof fetch
  private readonly nowImpl: () => number
  private readonly cacheFile: string
  private readonly url: string

  private models = new Map<string, CatalogModel>()
  /** Hostname of a provider's API to the catalog ids that use it, for endpoints the app was not told about. */
  private hosts = new Map<string, Set<string>>()
  private etag?: string
  private lastUpdated = 0
  private initialized = false
  private inflight?: Promise<CatalogRefreshResult>

  constructor(options: ModelCatalogOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.nowImpl = options.now ?? Date.now
    this.cacheFile = options.cachePath ?? join(dataDir(), 'models-dev-catalog.json')
    this.url = options.url ?? MODELS_DEV_URL
  }

  private key(providerId: string, modelId: string): string {
    return `${providerId.toLowerCase()}::${modelId.toLowerCase()}`
  }

  /** Initialize catalog by loading disk cache if present. Non-blocking. */
  initSync(): void {
    if (this.initialized) return
    this.initialized = true
    this.readCacheFile()
  }

  private readCacheFile(): boolean {
    try {
      if (!existsSync(this.cacheFile)) return false
      const raw = readFileSync(this.cacheFile, 'utf8')
      const parsed = JSON.parse(raw) as DiskCache
      if (parsed && typeof parsed === 'object') {
        this.etag = parsed.etag
        this.lastUpdated = parsed.updatedAt ?? 0
        if (parsed.raw) {
          return this.parseAndIngest(parsed.raw) > 0
        }
      }
    } catch {
      // ignore corrupt cache file
    }
    return false
  }

  /** The cached models.dev payload, or undefined when the file is missing, corrupt or empty. */
  private readCachedRaw(): unknown {
    try {
      if (!existsSync(this.cacheFile)) return undefined
      const parsed = JSON.parse(readFileSync(this.cacheFile, 'utf8')) as DiskCache
      const raw = parsed?.raw
      if (!raw || typeof raw !== 'object' || Object.keys(raw as object).length === 0) return undefined
      return raw
    } catch {
      return undefined
    }
  }

  private saveCacheFile(raw: unknown): void {
    try {
      const payload: DiskCache = {
        etag: this.etag,
        updatedAt: this.lastUpdated,
        raw
      }
      writeFileSync(this.cacheFile, JSON.stringify(payload), 'utf8')
    } catch {
      // ignore write failures
    }
  }

  /** Ingest a models.dev payload. Returns how many models it contributed. */
  private parseAndIngest(data: unknown): number {
    if (!data || typeof data !== 'object') return 0
    const records = data as Record<string, any>
    let ingested = 0
    // models.dev format: Record<providerKey, { id: string, name: string, api?: string, models: Record<modelKey, ModelData> }>
    for (const [providerKey, providerValRaw] of Object.entries(records)) {
      if (!providerValRaw || typeof providerValRaw !== 'object') continue
      const providerVal = providerValRaw as Record<string, any>
      const providerId = (providerVal.id || providerKey).toLowerCase()
      const modelsObj = providerVal.models
      if (!modelsObj || typeof modelsObj !== 'object') continue

      if (typeof providerVal.api === 'string') {
        try {
          const host = new URL(providerVal.api).hostname.toLowerCase()
          const ids = this.hosts.get(host) ?? new Set<string>()
          ids.add(providerId)
          this.hosts.set(host, ids)
        } catch {
          // an address that is not a URL names no host
        }
      }

      for (const [modelKey, modelValRaw] of Object.entries(modelsObj as Record<string, any>)) {
        if (!modelValRaw || typeof modelValRaw !== 'object') continue
        const modelVal = modelValRaw as Record<string, any>
        const modelId = modelVal.id || modelKey
        const limit = (modelVal.limit ?? {}) as Record<string, any>
        const cost = modelVal.cost && typeof modelVal.cost === 'object' ? (modelVal.cost as Record<string, any>) : undefined

        const contextWindow = positive(limit.context)
        const maxInputTokens = positive(limit.input)
        const maxOutputTokens = positive(limit.output)

        // A price needs at least an input or an output rate; a model with neither is unpriced, not free.
        const hasPrice = !!cost && (typeof cost.input === 'number' || typeof cost.output === 'number')
        const pricing: CatalogModelPricing | undefined = hasPrice
          ? {
              inputPerMTok: typeof cost!.input === 'number' ? cost!.input : 0,
              outputPerMTok: typeof cost!.output === 'number' ? cost!.output : 0,
              ...(typeof cost!.cache_read === 'number' ? { cachedInputPerMTok: cost!.cache_read } : {}),
              ...(typeof cost!.cache_write === 'number' ? { cacheWritePerMTok: cost!.cache_write } : {}),
              currency: 'USD',
              source: 'catalog'
            }
          : undefined

        const supportsTools = modelVal.tool_call !== false
        const supportsReasoning = modelVal.reasoning === true
        const supportsAttachments = modelVal.attachment === true
        const reasoningEfforts = supportsReasoning ? effortsOf(modelVal.reasoning_options) : undefined

        const caps: Capability[] = ['text', 'streaming', 'cancellation']
        if (supportsTools) caps.push('tools')

        const catalogModel: CatalogModel = {
          id: modelId,
          providerId,
          displayName: modelVal.name || modelId,
          ...(typeof modelVal.family === 'string' ? { family: modelVal.family } : {}),
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
          ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
          supportsTools,
          supportsReasoning,
          supportsAttachments,
          ...(reasoningEfforts !== undefined ? { reasoningEfforts } : {}),
          ...(pricing ? { pricing } : {}),
          capabilities: caps
        }

        this.models.set(this.key(providerId, modelId), catalogModel)
        ingested++
      }
    }
    return ingested
  }

  /** Refresh models.dev catalog if TTL expired or forced. Concurrent callers share one request. */
  refresh(force = false): Promise<CatalogRefreshResult> {
    this.inflight ??= this.fetchAndIngest(force).finally(() => { this.inflight = undefined })
    return this.inflight
  }

  private async fetchAndIngest(force: boolean): Promise<CatalogRefreshResult> {
    this.initSync()
    const now = this.nowImpl()
    if (!force && this.lastUpdated > 0 && now - this.lastUpdated < CATALOG_TTL_MS) {
      return { ok: true }
    }

    try {
      const headers: Record<string, string> = {
        Accept: 'application/json'
      }
      if (this.etag) {
        headers['If-None-Match'] = this.etag
      }

      const res = await this.fetchImpl(this.url, {
        headers,
        signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS)
      })

      if (res.status === 304) {
        // Not modified. Only trust that when the cached payload is still
        // usable: persisting an ETag with no models would suppress every later
        // refresh and leave the catalog permanently empty.
        const cachedRaw = this.readCachedRaw()
        if (cachedRaw === undefined) {
          this.etag = undefined
          this.lastUpdated = 0
          // Rewrite without the ETag so the next fetch is unconditional.
          this.saveCacheFile(undefined)
          return {
            ok: false,
            error: 'The catalog reported no change, but the cached catalog is missing or unreadable. It will be downloaded again on the next refresh.'
          }
        }
        this.lastUpdated = now
        this.saveCacheFile(cachedRaw)
        return { ok: true }
      }

      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status}: ${res.statusText}` }
      }

      const newEtag = res.headers.get('etag')

      const data = await res.json()
      const ingested = this.parseAndIngest(data)
      if (ingested === 0) {
        // Never record success with nothing to show for it: keeping the ETag
        // or the timestamp here would suppress refreshes for six hours.
        return { ok: false, error: 'The catalog response contained no usable models.' }
      }
      if (newEtag) this.etag = newEtag
      this.lastUpdated = now
      this.saveCacheFile(trimCatalog(data))

      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  /**
   * Ready to answer. With a catalog already on disk that is immediate, and a refresh runs behind it when it is due.
   * With none, wait for the first download, but never longer than `timeoutMs`: the model list must not hang on it.
   */
  async ready(timeoutMs: number): Promise<void> {
    this.initSync()
    if (this.lastUpdated > 0) {
      void this.refresh()
      return
    }
    await Promise.race([this.refresh(), new Promise<void>((resolve) => { setTimeout(resolve, timeoutMs).unref() })])
  }

  getStatus(): CatalogStatus {
    this.initSync()
    return {
      updatedAt: this.lastUpdated || undefined,
      source: this.lastUpdated > 0 ? 'catalog' : 'builtin',
      models: this.models.size
    }
  }

  /** What the catalog knows about a model of a provider. A model of another provider is never a match. */
  lookup(providerId: string, modelId: string): CatalogModel | undefined {
    this.initSync()
    return this.models.get(this.key(providerId, modelId))
  }

  /** The catalog provider whose API lives at this host, when exactly one does. */
  providerForHost(host: string): string | undefined {
    this.initSync()
    const ids = this.hosts.get(host.toLowerCase())
    return ids && ids.size === 1 ? [...ids][0] : undefined
  }
}

let shared: ModelCatalog | undefined

/** The one catalog the app shares, created on first use so importing this module costs nothing. */
export function sharedModelCatalog(): ModelCatalog {
  shared ??= new ModelCatalog()
  return shared
}
