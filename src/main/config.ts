import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { DEFAULT_TIMEOUT_CONFIG } from '@core/types'
import { configPath } from './paths'
import { DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION, type AppSettings } from '@shared/settings'
import { normalizeAiPolicy } from '@shared/contextPolicy'
import { normalizePeerSettings } from '@shared/peers'
import { normalizeUpdateSettings } from '@shared/updates'

/**
 * App settings persisted as a plain JSON file (contains NO secrets — those live
 * in the encrypted credential store). Deep-merged with defaults on load so new
 * settings keys appear for existing installs.
 */
let cache: AppSettings | null = null

function deepMerge<T>(base: T, patch: Partial<T>): T {
  const out = { ...base } as Record<string, unknown>
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k]) {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>)
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  return out as T
}

/** Compaction and budget keys, the other agents and the update choices always leave here in their canonical shape (one auto switch, valid caps, only agents that pass the checks, a skipped version that is a version). */
function canonical(settings: AppSettings): AppSettings {
  return { ...settings, ai: normalizeAiPolicy(settings.ai), peers: normalizePeerSettings(settings.peers), updates: normalizeUpdateSettings(settings.updates) }
}

/**
 * One-time rewrites of a file that an older build wrote, run as it is loaded. A saved value beats a default, so a
 * changed default never reaches an install that already saved the old one; each step below is how it does.
 * `meta.schemaVersion` records the steps that have run, and a file without it predates all of them.
 *
 * Version 1:
 *  - Request limits: earlier builds saved a 2 minute wait for the first response and a wall clock, which cut slow
 *    providers in the middle of an answer. Both are replaced by the current defaults.
 *  - Reply length: 4096 tokens was the old default and now reads as a choice. It becomes Automatic (0); any other
 *    number was chosen by the person and stays.
 */
function migrate(settings: AppSettings, storedVersion: unknown): { settings: AppSettings; changed: boolean } {
  const version = typeof storedVersion === 'number' ? storedVersion : 0
  if (version >= SETTINGS_SCHEMA_VERSION) return { settings, changed: false }
  const ai: AppSettings['ai'] = {
    ...settings.ai,
    timeout: { ...DEFAULT_TIMEOUT_CONFIG },
    ...(settings.ai.maxOutputTokens === 4096 ? { maxOutputTokens: 0 } : {})
  }
  return { settings: { ...settings, ai, meta: { schemaVersion: SETTINGS_SCHEMA_VERSION } }, changed: true }
}

/** Atomic replace: a crash mid-write must not leave truncated JSON behind. */
function writeSettings(settings: AppSettings): void {
  const file = configPath()
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(settings, null, 2), { mode: 0o600 })
  renameSync(temp, file)
}

export function getSettings(): AppSettings {
  if (cache) return cache
  const file = configPath()
  let migrated = false
  if (existsSync(file)) {
    try {
      const stored = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppSettings>
      const result = migrate(deepMerge(DEFAULT_SETTINGS, stored), stored.meta?.schemaVersion)
      cache = canonical(result.settings)
      migrated = result.changed
    } catch {
      // Falling back to defaults drops configured PreToolUse guard hooks and MCP
      // servers. Preserve the damaged file so they can be recovered (the UI should
      // surface this; see audit roadmap) instead of overwriting it on next save.
      try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch { /* best effort */ }
      cache = canonical({ ...DEFAULT_SETTINGS })
    }
  } else {
    cache = canonical({ ...DEFAULT_SETTINGS })
  }
  // Saved at once so the step does not run again, but a file that cannot be written is no reason to fail the load:
  // the step is then repeated on the next start.
  if (migrated) {
    try { writeSettings(cache) } catch { /* best effort */ }
  }
  return cache
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const merged = canonical(deepMerge(getSettings(), patch))
  cache = merged
  writeSettings(merged)
  return merged
}
