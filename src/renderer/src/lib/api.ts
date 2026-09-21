import type { CubexAPI } from '../../../shared/ipc'

/**
 * Typed accessor for the preload-exposed API. The bridge attaches `window.cubex`
 * (see src/preload/index.ts); this gives the renderer full type safety.
 */
declare global {
  interface Window {
    cubex: CubexAPI
  }
}

/**
 * In Electron, `window.cubex` is injected by the preload bridge. When the
 * renderer is opened directly in a browser (design review / renderer-only dev),
 * we fall back to a no-op stub so the UI still renders. The stub never fabricates
 * results — it returns empty data and a clear "browser preview" notice.
 */
function browserStub(): CubexAPI {
  const empty = async (): Promise<never[]> => []
  const noop = async (): Promise<void> => undefined
  const unavailable = { ok: false, message: 'Not available in browser preview (run the Electron app).' }
  return {
    listProviders: empty,
    saveProvider: async (cfg) => cfg,
    deleteProvider: noop,
    testProvider: async () => unavailable,
    listModels: empty,
    startChat: async () => ({ streamId: 'browser' }),
    cancelChat: noop,
    onChatEvent: () => () => undefined,
    listConversations: empty,
    getConversation: async () => null,
    createConversation: async (p) => ({
      id: 'browser',
      title: p.title ?? 'Preview',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      execution: 'cloud',
      messages: []
    }),
    updateConversation: noop,
    deleteConversation: noop,
    searchConversations: empty,
    exportConversation: async () => '',
    importConversation: async () => ({ id: 'b', title: 'b', createdAt: 0, updatedAt: 0, execution: 'cloud', messages: [] }),
    listPresets: empty,
    savePreset: async (p) => p,
    deletePreset: noop,
    getSettings: async () => (await import('../../../shared/settings')).DEFAULT_SETTINGS,
    updateSettings: async () => (await import('../../../shared/settings')).DEFAULT_SETTINGS,
    scanHardware: async () => ({
      cpu: { model: 'Browser preview', architecture: 'n/a', physicalCores: 0, logicalThreads: 0 },
      memory: { totalBytes: 0, availableBytes: 0 },
      gpus: [],
      storage: { totalBytes: 0, freeBytes: 0 },
      os: { platform: 'browser', arch: 'n/a' },
      accelerators: ['cpu'],
      detectedAt: Date.now()
    }),
    analyzeModels: empty,
    listRuntimes: empty,
    startRuntime: async () => ({ id: 'x', name: 'x', installed: false, running: false }),
    stopRuntime: async () => ({ id: 'x', name: 'x', installed: false, running: false }),
    listLocalModels: empty,
    browseModels: empty,
    pullModel: async () => ({ pullId: 'browser' }),
    cancelPull: noop,
    deleteLocalModel: noop,
    onPullProgress: () => () => undefined,
    runBenchmark: async () => ({ benchId: 'browser' }),
    cancelBenchmark: noop,
    listBenchmarks: empty,
    onBenchmarkProgress: () => () => undefined,
    getUsage: async () => ({ today: 0, week: 0, month: 0, currency: 'USD', byProvider: {}, byModel: {} }),
    getLogs: empty,
    exportLogs: async () => '',
    windowMinimize: noop,
    windowToggleMaximize: async () => false,
    windowClose: noop,
    windowIsMaximized: async () => false,
    pickWorkspace: async () => null
  }
}

export const api: CubexAPI = window.cubex ?? browserStub()
export const isBrowserPreview = !window.cubex

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

export function formatCost(n: number, currency = 'USD'): string {
  const sym = currency === 'USD' ? '$' : ''
  return `${sym}${n.toFixed(n < 1 ? 4 : 2)}`
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  return new Date(ts).toLocaleDateString()
}
