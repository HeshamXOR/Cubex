import type { ChatEvent, CubexAPI, PullProgress } from '../../../shared/ipc'
import type { UpdateState } from '../../../shared/updates'
import { seededApi } from './seeds'

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
  const idleUpdates: UpdateState = { currentVersion: '0.0.0', canInstall: false, check: { status: 'idle' } }
  return {
    listProviders: empty,
    saveProvider: async (cfg) => cfg,
    deleteProvider: noop,
    testProvider: async () => unavailable,
    listModels: empty,
    startChat: async () => ({ streamId: 'browser' }),
    cancelChat: noop,
    onChatEvent: () => () => undefined,
    resolvePermission: noop,
    listPermissionRules: empty,
    removePermissionRule: noop,
    getSessionChanges: empty,
    revertSessionChanges: async () => ({ restored: [], skipped: [] }),
    getGitStatus: async () => null,
    gitCommit: async () => ({ ok: false, error: unavailable.message }),
    gitSuggestMessage: async () => '',
    rewindFiles: async () => ({ restored: [] }),
    getDiagnostics: empty,
    getDiagnosticsStatus: async () => ({ available: false, reason: unavailable.message }),
    getReview: empty,
    revertHunks: async () => ({ applied: [], conflicts: [], newHeadHash: null }),
    markReviewed: noop,
    undoRevert: async () => ({ restored: [] }),
    sendReviewComments: async () => { throw new Error(unavailable.message) },
    restoreCheckpoint: async () => ({ restored: [], skipped: [], failed: [] }),
    previewRestore: async () => ({ checkpoint: false, files: [], blocked: [] }),
    undoRestore: async () => { throw new Error(unavailable.message) },
    resolveQuestion: noop,
    resolvePlan: noop,
    listPlans: empty,
    getPlan: async () => null,
    revealPlan: noop,
    readCommandOutput: async () => { throw new Error('Saved command output is not available in browser preview.') },
    revealCommandOutput: noop,
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
    compactConversation: async () => ({ ok: false, error: 'Not available in browser preview.' }),
    deleteConversation: noop,
    searchConversations: empty,
    exportConversation: async () => '',
    importConversation: async () => ({ id: 'b', title: 'b', createdAt: 0, updatedAt: 0, execution: 'cloud', messages: [] }),
    listPresets: empty,
    savePreset: async (p) => p,
    deletePreset: noop,
    getSettings: async () => (await import('../../../shared/settings')).DEFAULT_SETTINGS,
    updateSettings: async () => (await import('../../../shared/settings')).DEFAULT_SETTINGS,
    listSkills: empty,
    readSkill: async () => { throw new Error('Skill instructions are available in the Electron app.') },
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
    pickWorkspace: async () => null,
    readWorkspaceDir: empty,
    searchWorkspaceFiles: empty,
    revealPath: noop,
    readWorkspaceFile: async () => { throw new Error('Files can be opened in the Electron app.') },
    listWorkspaceDir: async () => ({ entries: [], omitted: 0 }),
    findWorkspaceFiles: empty,
    statWorkspacePaths: async (paths) => paths.map(() => ({ kind: 'missing' as const })),
    setActiveConversation: noop,
    onOpenConversation: () => () => undefined,
    sendTestNotification: async () => ({ shown: false, reason: unavailable.message }),
    listShells: empty,
    listTasks: empty,
    stopTask: async () => ({ ok: true }),
    sendTaskInput: async () => ({ ok: true }),
    testMcpServer: async () => ({ ok: false, durationMs: 0, tools: [], toolCount: 0, error: unavailable.message }),
    getMcpStatus: empty,
    testHook: async () => { throw new Error(unavailable.message) },
    getUsageReport: async () => {
      const none = { costUsd: 0, requests: 0, tokens: 0, byProvider: [], byModel: [] }
      return { generatedAt: Date.now(), today: none, week: none, month: none, budget: { action: 'warn' as const, meters: [], spent: { daily: 0 } } }
    },
    refreshModels: async () => ({ ok: false, count: 0, message: unavailable.message }),
    appInfo: async () => ({ version: '0.0.0', packaged: false, electron: '', chrome: '', node: '', platform: 'browser', arch: '', osRelease: '', dataDir: '', logsDir: '' }),
    openAppFolder: async () => unavailable.message,
    saveMcpSecret: async () => ({ ok: false, message: unavailable.message }),
    forgetMcpSecrets: noop,
    getPeersStatus: async () => ({ peers: [], presets: [], localOnly: false }),
    testPeer: async () => ({ ok: false, durationMs: 0, error: unavailable.message }),
    getUpdateState: async () => idleUpdates,
    checkForUpdates: async () => ({ ...idleUpdates, check: { status: 'failed' as const, error: unavailable.message } }),
    downloadUpdate: async () => idleUpdates,
    cancelUpdateDownload: async () => idleUpdates,
    installUpdate: async () => ({ ok: false as const, reason: 'failed' as const, message: unavailable.message }),
    skipUpdate: async () => idleUpdates,
    openUpdatePage: noop,
    onUpdateState: () => () => undefined
  }
}

/**
 * Layer representative mock data over the stub for design review, activated by
 * `?seed` on the preview URL. Dev-only: `window.cubex` is always present in the
 * packaged app, so this branch never runs there.
 */
function seededStub(): CubexAPI {
  const base = browserStub()
  // Preview scripts push chat events through `window.__emit`, the way main would.
  const listeners = new Set<(e: ChatEvent) => void>()
  ;(window as unknown as { __emit: (e: ChatEvent) => void }).__emit = (e) => listeners.forEach((listener) => listener(e))
  // Downloads are simulated so the progress, cancel and failure states can be reviewed:
  // `pull=hold` stops partway, `pull=fail` reports Ollama unreachable.
  type PullEvent = PullProgress & { pullId: string }
  const pullListeners = new Set<(p: PullEvent) => void>()
  const pullTimers = new Map<string, number>()
  const pullModels = new Map<string, string>()
  const emitPull = (p: PullEvent): void => pullListeners.forEach((listener) => listener(p))
  const runtimeDown = (): boolean => /[?&]runtime=down\b/.test(location.search)
  const stub: CubexAPI = {
    ...base,
    onChatEvent: (cb) => {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
    scanHardware: async () => (await import('./previewSeed')).seedHardware,
    analyzeModels: async () => (await import('./previewSeed')).seedCompatibility(),
    listRuntimes: async () => (await import('./previewSeed')).seedRuntimes(runtimeDown()),
    listLocalModels: async () => (runtimeDown() ? [] : [...(await import('./previewSeed')).seedLocalModels]),
    deleteLocalModel: async (_runtime, modelId) => {
      const { seedLocalModels } = await import('./previewSeed')
      const index = seedLocalModels.findIndex((entry) => entry.id === modelId)
      if (index >= 0) seedLocalModels.splice(index, 1)
    },
    onPullProgress: (cb) => {
      pullListeners.add(cb)
      return () => { pullListeners.delete(cb) }
    },
    pullModel: async (req) => {
      const pullId = `seed-${Math.random().toString(36).slice(2, 8)}`
      pullModels.set(pullId, req.modelId)
      const flag = new URLSearchParams(location.search).get('pull')
      const total = 4.9 * 1024 ** 3
      const send = (p: Omit<PullProgress, 'modelId'>): void => emitPull({ pullId, modelId: req.modelId, ...p })
      if (flag === 'fail') {
        pullTimers.set(pullId, window.setTimeout(() => send({ status: 'error', done: true, error: 'Could not reach Ollama at http://127.0.0.1:11434. Make sure Ollama is running. (fetch failed)' }), 500))
        return { pullId }
      }
      send({ status: 'pulling manifest', done: false })
      let completed = 0
      const tick = (): void => {
        completed = Math.min(total, completed + total * (flag === 'hold' ? 0.38 : 0.12))
        send({ status: 'downloading', completedBytes: completed, totalBytes: total, speedBps: 38.5 * 1024 ** 2, etaSeconds: Math.round((total - completed) / (38.5 * 1024 ** 2)), done: false })
        if (flag === 'hold') return
        if (completed < total) pullTimers.set(pullId, window.setTimeout(tick, 450))
        else {
          send({ status: 'verifying', done: false })
          pullTimers.set(pullId, window.setTimeout(() => send({ status: 'success', done: true }), 600))
        }
      }
      pullTimers.set(pullId, window.setTimeout(tick, 500))
      return { pullId }
    },
    cancelPull: async (pullId) => {
      window.clearTimeout(pullTimers.get(pullId))
      emitPull({ pullId, modelId: pullModels.get(pullId) ?? '', status: 'cancelled', done: true })
    },
    listProviders: async () => (await import('./previewSeed')).seedProviders,
    listModels: async (id) => (await import('./previewSeed')).seedModels[id] ?? [],
    listConversations: async () => (await import('./previewSeed')).seedConversations,
    getConversation: async (id) => (await import('./previewSeed')).seedConversation(id),
    getSessionChanges: async () => (await import('./previewSeed')).seedChanges(),
    revertSessionChanges: async (_id, paths) => (await import('./previewSeed')).seedRevert(paths),
    getGitStatus: async () => ({ ...(await import('./previewSeed')).seedGit }),
    // `suggest=slow` and `commit=fail` hold the commit sheet in its loading and error states for review.
    gitSuggestMessage: async () => {
      if (/[?&]suggest=slow\b/.test(location.search)) await new Promise((resolve) => setTimeout(resolve, 8000))
      return 'Retry uploads on 429 and 5xx with backoff'
    },
    gitCommit: async (_id, request) => {
      await new Promise((resolve) => setTimeout(resolve, 700))
      const seed = await import('./previewSeed')
      if (/[?&]commit=fail\b/.test(location.search)) return { ok: false, error: seed.seedCommitFailure }
      seed.seedCommitted(request.paths.length)
      const subject = request.message.split('\n')[0] ?? ''
      return { ok: true, commit: 'e4f7a21', summary: `${subject}\n${request.paths.length} ${request.paths.length === 1 ? 'file' : 'files'} changed, 55 insertions(+), 3 deletions(-)` }
    },
    getUsage: async () => ({ today: 4.12, week: 18.4, month: 61.9, currency: 'USD', byProvider: {}, byModel: {} }),
    searchWorkspaceFiles: async (query, limit = 50) => {
      const { seedFiles } = await import('./previewSeed')
      const q = (query ?? '').toLowerCase()
      return seedFiles
        .filter((f) => !q || f.path.toLowerCase().includes(q))
        .slice(0, limit)
        .map((f) => ({ name: f.path.split('/').pop() ?? f.path, path: f.path, isDirectory: false }))
    },
    getSettings: async () => {
      const { DEFAULT_SETTINGS } = await import('../../../shared/settings')
      const { SEED_WORKSPACE } = await import('./previewSeed')
      return {
        ...DEFAULT_SETTINGS,
        general: {
          ...DEFAULT_SETTINGS.general,
          workspacePath: SEED_WORKSPACE,
          recentWorkspaces: [SEED_WORKSPACE, 'C:\\Users\\dev\\code\\aurora-site']
        }
      }
    }
  }
  // Feature seeds (lib/seeds/*.ts) win over the defaults above.
  return { ...stub, ...seededApi(new URLSearchParams(location.search)) }
}

// `import.meta.env.DEV` is replaced at build time, which lets the bundler drop the seeded stub and every seed with it from the packaged app.
const isSeed = import.meta.env.DEV && typeof location !== 'undefined' && /[?&]seed\b/.test(location.search)
export const isBrowserPreview = !window.cubex
export const api: CubexAPI = window.cubex ?? (isSeed ? seededStub() : browserStub())

export { formatBytes } from './format'

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
