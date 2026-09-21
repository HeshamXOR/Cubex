import { app } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'

/**
 * Centralized data paths. Everything lives under a single app data directory so
 * conversations, config, logs and models are easy to find and back up.
 * CUBEX_DATA_DIR / CUBEX_MODELS_DIR env vars override the defaults (dev use).
 */
function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function dataDir(): string {
  const override = process.env.CUBEX_DATA_DIR
  const base = override && override.trim() ? override : join(app.getPath('userData'), 'cubex-data')
  return ensureDir(base)
}

export function dbPath(): string {
  return join(dataDir(), 'cubex.db')
}

export function configPath(): string {
  return join(dataDir(), 'config.json')
}

export function logsDir(): string {
  return ensureDir(join(dataDir(), 'logs'))
}

export function defaultModelsDir(): string {
  const override = process.env.CUBEX_MODELS_DIR
  const base = override && override.trim() ? override : join(dataDir(), 'models')
  return ensureDir(base)
}
