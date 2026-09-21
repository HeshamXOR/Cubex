import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type CubexAPI } from '../shared/ipc'

/**
 * The preload bridge. Exposes a typed, minimal `window.cubex` API to the
 * renderer over contextIsolation — no Node, no ipcRenderer leak. Every method
 * maps to an IPC channel; event subscriptions return an unsubscribe function.
 */
const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: CubexAPI = {
  // Providers
  listProviders: () => invoke(IPC.listProviders),
  saveProvider: (cfg, secret) => invoke(IPC.saveProvider, cfg, secret),
  deleteProvider: (id) => invoke(IPC.deleteProvider, id),
  testProvider: (id) => invoke(IPC.testProvider, id),
  listModels: (providerId) => invoke(IPC.listModels, providerId),

  // Chat
  startChat: (req) => invoke(IPC.startChat, req),
  cancelChat: (streamId) => invoke(IPC.cancelChat, streamId),
  onChatEvent: (cb) => subscribe(IPC.chatEvent, cb),

  // Conversations
  listConversations: () => invoke(IPC.listConversations),
  getConversation: (id) => invoke(IPC.getConversation, id),
  createConversation: (partial) => invoke(IPC.createConversation, partial),
  updateConversation: (id, patch) => invoke(IPC.updateConversation, id, patch),
  deleteConversation: (id) => invoke(IPC.deleteConversation, id),
  searchConversations: (query) => invoke(IPC.searchConversations, query),
  exportConversation: (id, format) => invoke(IPC.exportConversation, id, format),
  importConversation: (data) => invoke(IPC.importConversation, data),

  // Presets
  listPresets: () => invoke(IPC.listPresets),
  savePreset: (p) => invoke(IPC.savePreset, p),
  deletePreset: (id) => invoke(IPC.deletePreset, id),

  // Settings
  getSettings: () => invoke(IPC.getSettings),
  updateSettings: (patch) => invoke(IPC.updateSettings, patch),

  // Hardware
  scanHardware: (force) => invoke(IPC.scanHardware, force),
  analyzeModels: (goal) => invoke(IPC.analyzeModels, goal),

  // Local runtimes / models
  listRuntimes: () => invoke(IPC.listRuntimes),
  startRuntime: (id) => invoke(IPC.startRuntime, id),
  stopRuntime: (id) => invoke(IPC.stopRuntime, id),
  listLocalModels: () => invoke(IPC.listLocalModels),
  browseModels: (query) => invoke(IPC.browseModels, query),
  pullModel: (req) => invoke(IPC.pullModel, req),
  cancelPull: (pullId) => invoke(IPC.cancelPull, pullId),
  deleteLocalModel: (runtime, modelId) => invoke(IPC.deleteLocalModel, runtime, modelId),
  onPullProgress: (cb) => subscribe(IPC.pullProgress, cb),

  // Benchmarks
  runBenchmark: (req) => invoke(IPC.runBenchmark, req),
  cancelBenchmark: (benchId) => invoke(IPC.cancelBenchmark, benchId),
  listBenchmarks: (modelId) => invoke(IPC.listBenchmarks, modelId),
  onBenchmarkProgress: (cb) => subscribe(IPC.benchmarkProgress, cb),

  // Usage
  getUsage: () => invoke(IPC.getUsage),

  // Developer / logs
  getLogs: (limit) => invoke(IPC.getLogs, limit),
  exportLogs: () => invoke(IPC.exportLogs),

  // Window controls
  windowMinimize: () => invoke(IPC.windowMinimize),
  windowToggleMaximize: () => invoke(IPC.windowToggleMaximize),
  windowClose: () => invoke(IPC.windowClose),
  windowIsMaximized: () => invoke(IPC.windowIsMaximized)
}

contextBridge.exposeInMainWorld('cubex', api)
