import type { RetryPolicy, TimeoutConfig } from '@core/types'
import { DEFAULT_RETRY_POLICY } from '@core/types'

export type ThemeMode = 'dark' | 'light' | 'system'

export interface AppSettings {
  general: {
    theme: ThemeMode
    language: string
    startMaximized: boolean
  }
  ai: {
    defaultProviderId?: string
    defaultModel?: string
    maxOutputTokens: number
    retry: RetryPolicy
    fallbackEnabled: boolean
    timeout: TimeoutConfig
  }
  local: {
    modelsDir?: string
    preferredRuntime: 'ollama' | 'llamacpp' | 'lmstudio' | 'custom'
    gpuAcceleration: boolean
    cpuThreads?: number
    contextSize: number
    gpuLayers?: number
    benchmarkRuns: number
    ollamaBaseUrl: string
  }
  privacy: {
    localOnly: boolean
    localLogging: boolean
    telemetry: boolean
    conversationRetentionDays: number
  }
  developer: {
    debugMode: boolean
    rawRequestLogging: boolean
    proxyUrl?: string
  }
}

export const DEFAULT_SETTINGS: AppSettings = {
  general: { theme: 'dark', language: 'en', startMaximized: false },
  ai: {
    maxOutputTokens: 4096,
    retry: DEFAULT_RETRY_POLICY,
    fallbackEnabled: false,
    timeout: { requestMs: 120_000, streamIdleMs: 60_000, totalMs: 300_000 }
  },
  local: {
    preferredRuntime: 'ollama',
    gpuAcceleration: true,
    contextSize: 4096,
    benchmarkRuns: 3,
    ollamaBaseUrl: 'http://127.0.0.1:11434'
  },
  privacy: {
    localOnly: false,
    localLogging: true,
    telemetry: false,
    conversationRetentionDays: 0 // 0 = keep forever
  },
  developer: { debugMode: false, rawRequestLogging: false }
}
