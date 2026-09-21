import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { configPath } from './paths'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/settings'

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

export function getSettings(): AppSettings {
  if (cache) return cache
  const file = configPath()
  if (existsSync(file)) {
    try {
      const stored = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppSettings>
      cache = deepMerge(DEFAULT_SETTINGS, stored)
    } catch {
      cache = { ...DEFAULT_SETTINGS }
    }
  } else {
    cache = { ...DEFAULT_SETTINGS }
  }
  return cache
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const merged = deepMerge(getSettings(), patch)
  cache = merged
  writeFileSync(configPath(), JSON.stringify(merged, null, 2))
  return merged
}
