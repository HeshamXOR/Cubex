import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { logsDir } from './paths'
import { logRepo } from './db'
import { redactObject, redactString } from '@core/redaction'
import type { LogEntry } from '@shared/ipc'
import { getSettings } from './config'

/**
 * Structured logger. Writes to SQLite (for the in-app log view) and a daily
 * JSONL file. ALWAYS redacts secrets before writing — no API keys, tokens,
 * cookies, or auth headers ever hit disk.
 */
function logFile(): string {
  const day = new Date().toISOString().slice(0, 10)
  return join(logsDir(), `cubex-${day}.jsonl`)
}

export function log(entry: Omit<LogEntry, 'ts'> & { ts?: number }): void {
  const settings = getSettings()
  if (!settings.privacy.localLogging) return
  const full: LogEntry = {
    ts: entry.ts ?? Date.now(),
    level: entry.level,
    message: redactString(entry.message),
    ...(entry.provider ? { provider: entry.provider } : {}),
    ...(entry.model ? { model: entry.model } : {}),
    ...(entry.requestId ? { requestId: entry.requestId } : {}),
    ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
    ...(entry.status ? { status: entry.status } : {}),
    ...(entry.retryCount !== undefined ? { retryCount: entry.retryCount } : {}),
    ...(entry.errorCategory ? { errorCategory: entry.errorCategory } : {})
  }
  const safe = redactObject(full)
  try {
    logRepo.append(safe)
    appendFileSync(logFile(), JSON.stringify(safe) + '\n')
  } catch {
    // Logging must never crash the app.
  }
}

export const logger = {
  debug: (message: string, extra: Partial<LogEntry> = {}) => log({ level: 'debug', message, ...extra }),
  info: (message: string, extra: Partial<LogEntry> = {}) => log({ level: 'info', message, ...extra }),
  warn: (message: string, extra: Partial<LogEntry> = {}) => log({ level: 'warn', message, ...extra }),
  error: (message: string, extra: Partial<LogEntry> = {}) => log({ level: 'error', message, ...extra })
}

export function recentLogs(limit = 500): LogEntry[] {
  return logRepo.recent(limit)
}
