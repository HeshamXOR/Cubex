import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type CubexAPI } from '../shared/ipc'
import { cleanIpcErrorMessage } from '../shared/ipcErrors'

/**
 * The preload bridge. Exposes a typed, minimal `window.cubex` API to the
 * renderer over contextIsolation — no Node, no ipcRenderer leak. Every method
 * maps to an IPC channel; event subscriptions return an unsubscribe function.
 */
const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T
  } catch (err) {
    // Electron prefixes a rejection with the channel name; people reading the error should not see it.
    if (err instanceof Error) err.message = cleanIpcErrorMessage(err.message)
    throw err
  }
}

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
  resolvePermission: (id, decision) => invoke(IPC.resolvePermission, id, decision),
  listPermissionRules: (workspace) => invoke(IPC.listPermissionRules, workspace),
  removePermissionRule: (id) => invoke(IPC.removePermissionRule, id),
  getSessionChanges: (conversationId) => invoke(IPC.getSessionChanges, conversationId),
  revertSessionChanges: (conversationId, paths) => invoke(IPC.revertSessionChanges, conversationId, paths),
  getGitStatus: (conversationId) => invoke(IPC.getGitStatus, conversationId),
  gitCommit: (conversationId, request) => invoke(IPC.gitCommit, conversationId, request),
  gitSuggestMessage: (conversationId) => invoke(IPC.gitSuggestMessage, conversationId),
  rewindFiles: (conversationId: string, messageId: string) => invoke(IPC.rewindFiles, conversationId, messageId),
  getDiagnostics: (conversationId, path) => invoke(IPC.diagnosticsGet, conversationId, path),
  getDiagnosticsStatus: (conversationId) => invoke(IPC.diagnosticsStatus, conversationId),
  getReview: (conversationId, scope) => invoke(IPC.reviewGet, conversationId, scope),
  revertHunks: (conversationId, req) => invoke(IPC.reviewRevertHunks, conversationId, req),
  markReviewed: (conversationId, items) => invoke(IPC.reviewMark, conversationId, items),
  undoRevert: (conversationId, revertId) => invoke(IPC.reviewUndo, conversationId, revertId),
  sendReviewComments: (conversationId, comments, options) => invoke(IPC.reviewComments, conversationId, comments, options),
  restoreCheckpoint: (conversationId, messageId, axes) => invoke(IPC.restoreCheckpoint, conversationId, messageId, axes),
  previewRestore: (conversationId, messageId) => invoke(IPC.restorePreview, conversationId, messageId),
  undoRestore: (conversationId, undoId) => invoke(IPC.restoreUndo, conversationId, undoId),
  resolveQuestion: (id, answers) => invoke(IPC.resolveQuestion, id, answers),

  resolvePlan: (id, decision, feedback) => invoke(IPC.resolvePlan, id, decision, feedback),
  listPlans: (conversationId) => invoke(IPC.listPlans, conversationId),
  getPlan: (id) => invoke(IPC.getPlan, id),
  revealPlan: (id) => invoke(IPC.revealPlan, id),
  readCommandOutput: (conversationId, id, offset, limit) => invoke(IPC.readCommandOutput, conversationId, id, offset, limit),
  revealCommandOutput: (conversationId, id) => invoke(IPC.revealCommandOutput, conversationId, id),

  // Conversations
  listConversations: () => invoke(IPC.listConversations),
  getConversation: (id) => invoke(IPC.getConversation, id),
  createConversation: (partial) => invoke(IPC.createConversation, partial),
  updateConversation: (id, patch) => invoke(IPC.updateConversation, id, patch),
  compactConversation: (conversationId) => invoke(IPC.compactConversation, conversationId),
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
  listSkills: (conversationId) => invoke(IPC.listSkills, conversationId),
  readSkill: (name, conversationId) => invoke(IPC.readSkill, name, conversationId),

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

  // Shell & background tasks
  listShells: () => invoke(IPC.shellList),
  listTasks: (conversationId) => invoke(IPC.tasksList, conversationId),
  stopTask: (taskId) => invoke(IPC.tasksStop, taskId),
  sendTaskInput: (taskId, input) => invoke(IPC.tasksInput, taskId, input),

  // Developer / logs
  getLogs: (limit) => invoke(IPC.getLogs, limit),
  exportLogs: () => invoke(IPC.exportLogs),

  // Window controls
  windowMinimize: () => invoke(IPC.windowMinimize),
  windowToggleMaximize: () => invoke(IPC.windowToggleMaximize),
  windowClose: () => invoke(IPC.windowClose),
  windowIsMaximized: () => invoke(IPC.windowIsMaximized),

  // Workspace
  pickWorkspace: () => invoke(IPC.pickWorkspace),
  readWorkspaceDir: (relPath, conversationId) => invoke(IPC.readWorkspaceDir, relPath, conversationId),
  searchWorkspaceFiles: (query, limit, conversationId) => invoke(IPC.searchWorkspaceFiles, query, limit, conversationId),
  revealPath: (relPath, conversationId) => invoke(IPC.revealPath, relPath, conversationId),

  // Files and notifications (notify-files)
  readWorkspaceFile: (relPath, conversationId, options) => invoke(IPC.readWorkspaceFile, relPath, conversationId, options),
  listWorkspaceDir: (relPath, conversationId, options) => invoke(IPC.listWorkspaceDir, relPath, conversationId, options),
  findWorkspaceFiles: (query, limit, conversationId, options) => invoke(IPC.findWorkspaceFiles, query, limit, conversationId, options),
  statWorkspacePaths: (paths, conversationId) => invoke(IPC.statWorkspacePaths, paths, conversationId),
  setActiveConversation: (conversationId) => invoke(IPC.notifyActiveConversation, conversationId),
  onOpenConversation: (cb) => subscribe(IPC.notifyOpenConversation, cb),
  sendTestNotification: () => invoke(IPC.notifyTest),

  // MCP servers and hooks (policy-mcp)
  testMcpServer: (request) => invoke(IPC.mcpTest, request),
  getMcpStatus: () => invoke(IPC.mcpStatus),
  testHook: (request) => invoke(IPC.hooksTest, request),

  // Spend and budgets (context-cost)
  getUsageReport: (conversationId) => invoke(IPC.getUsageReport, conversationId),

  // Providers (local-providers)
  refreshModels: (providerId) => invoke(IPC.refreshModels, providerId),

  // About (lead)
  appInfo: () => invoke(IPC.appInfo),
  openAppFolder: (kind) => invoke(IPC.openAppFolder, kind),

  // MCP server environment (policy-mcp)
  saveMcpSecret: (request) => invoke(IPC.mcpSaveSecret, request),
  forgetMcpSecrets: (request) => invoke(IPC.mcpForgetSecrets, request)
}

contextBridge.exposeInMainWorld('cubex', api)
