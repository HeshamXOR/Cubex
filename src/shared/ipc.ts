import type {
  AIStreamEvent,
  BenchmarkConfig,
  BenchmarkResult,
  CompatibilityResult,
  GatewayEvent,
  MessageContentPart,
  ModelInfo,
  NormalizedAIErrorData,
  ProviderConfig,
  RoutingPolicy,
  SamplingParams,
  SystemProfile,
  Usage,
  ValidationResult
} from '@core/types'
import type { AppSettings } from './settings'

// ---------------------------------------------------------------------------
// Persisted domain objects (stored in SQLite, main process)
// ---------------------------------------------------------------------------

export interface StoredMessage {
  id: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  /** Rendered text; full content parts stored as JSON in `contentJson`. */
  text: string
  contentJson?: string
  createdAt: number
  usage?: Usage
  toolCallsJson?: string
  error?: NormalizedAIErrorData
}

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  providerId?: string
  model?: string
  execution: 'cloud' | 'local' | 'hybrid'
  presetId?: string
  messages: StoredMessage[]
  totalUsage?: Usage
}

export interface ConversationSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  providerId?: string
  model?: string
  execution: 'cloud' | 'local' | 'hybrid'
  messageCount: number
}

export interface Preset {
  id: string
  name: string
  providerId: string
  model: string
  systemPrompt?: string
  params?: SamplingParams
  fallbackEnabled?: boolean
  fallbacks?: RoutingPolicy['fallbacks']
  toolIds?: string[]
  notes?: string
}

export interface UsageRecord {
  id: string
  ts: number
  providerId: string
  model: string
  execution: 'cloud' | 'local'
  inputTokens: number
  outputTokens: number
  totalTokens: number
  estimatedCost: number
  currency: string
}

export interface UsageSummary {
  today: number
  week: number
  month: number
  currency: string
  byProvider: Record<string, number>
  byModel: Record<string, number>
}

export interface LogEntry {
  ts: number
  level: 'debug' | 'info' | 'warn' | 'error'
  provider?: string
  model?: string
  requestId?: string
  durationMs?: number
  status?: string
  retryCount?: number
  errorCategory?: string
  message: string
}

// ---------------------------------------------------------------------------
// Local runtimes / models
// ---------------------------------------------------------------------------

export interface RuntimeStatus {
  id: string
  name: string
  installed: boolean
  running: boolean
  version?: string
  endpoint?: string
  error?: string
}

export interface LocalModelEntry {
  id: string
  name: string
  runtime: string
  sizeBytes?: number
  quantization?: string
  parameterCount?: number
  family?: string
  location?: string
  lastUsed?: number
}

export interface PullProgress {
  modelId: string
  status: string
  completedBytes?: number
  totalBytes?: number
  speedBps?: number
  etaSeconds?: number
  done: boolean
  error?: string
}

export interface ModelCompatibility extends CompatibilityResult {
  model: ModelInfo
}

// ---------------------------------------------------------------------------
// Chat streaming
// ---------------------------------------------------------------------------

export interface ChatStartRequest {
  conversationId: string
  policy: RoutingPolicy
  systemPrompt?: string
  /** The new user message text (attachments referenced by id). */
  userText: string
  attachmentIds?: string[]
  /** Register the built-in subagent delegation tool for this turn. */
  subagentEnabled?: boolean
  /** Register workspace-scoped file tools (read/list/search/write). */
  fileToolsEnabled?: boolean
  /** Opt into a provider's 1M-context beta (for gated long-context models). */
  longContext?: boolean
  /** Attachments (image/file content parts) to include with the user message. */
  attachments?: MessageContentPart[]
}

/** Lifecycle of a single tool invocation, for the in-thread activity cards. */
export interface ToolActivity {
  id: string
  name: string
  phase: 'running' | 'done' | 'error'
  /** Short human title, e.g. "Edit src/app.ts" or "Read README.md". */
  title?: string
  /** One-line detail / result summary. */
  detail?: string
  /** Diff stats for edit/write tools. */
  added?: number
  removed?: number
}

/** A permission request surfaced to the user before a tool runs. */
export interface PermissionAsk {
  id: string
  toolName: string
  title: string
  detail?: string
}

export type ChatEvent =
  | { streamId: string; kind: 'stream'; event: AIStreamEvent }
  | { streamId: string; kind: 'gateway'; event: GatewayEvent }
  | { streamId: string; kind: 'tool'; tool: ToolActivity }
  | { streamId: string; kind: 'permission'; ask: PermissionAsk }

export interface PullRequest {
  runtime: string
  modelId: string
}

export interface BenchmarkRequest {
  config: BenchmarkConfig
}

// ---------------------------------------------------------------------------
// The full preload-exposed API surface (window.cubex).
// Main implements handlers; renderer consumes this interface.
// ---------------------------------------------------------------------------

export interface CubexAPI {
  // Providers
  listProviders(): Promise<ProviderConfig[]>
  saveProvider(cfg: ProviderConfig, secret?: string): Promise<ProviderConfig>
  deleteProvider(id: string): Promise<void>
  testProvider(id: string): Promise<ValidationResult>
  listModels(providerId: string): Promise<ModelInfo[]>

  // Chat (streaming pushed via onChatEvent)
  startChat(req: ChatStartRequest): Promise<{ streamId: string }>
  cancelChat(streamId: string): Promise<void>
  onChatEvent(cb: (e: ChatEvent) => void): () => void
  /** Resolve a tool permission request raised during a chat turn. */
  resolvePermission(id: string, decision: 'allow' | 'deny'): Promise<void>

  // Conversations
  listConversations(): Promise<ConversationSummary[]>
  getConversation(id: string): Promise<Conversation | null>
  createConversation(partial: Partial<Conversation>): Promise<Conversation>
  updateConversation(id: string, patch: Partial<Conversation>): Promise<void>
  deleteConversation(id: string): Promise<void>
  searchConversations(query: string): Promise<ConversationSummary[]>
  exportConversation(id: string, format: 'json' | 'markdown' | 'txt'): Promise<string>
  importConversation(data: string): Promise<Conversation>

  // Presets
  listPresets(): Promise<Preset[]>
  savePreset(p: Preset): Promise<Preset>
  deletePreset(id: string): Promise<void>

  // Settings
  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>

  // Hardware / recommendations
  scanHardware(force?: boolean): Promise<SystemProfile>
  analyzeModels(goal?: string): Promise<ModelCompatibility[]>

  // Local runtimes / models
  listRuntimes(): Promise<RuntimeStatus[]>
  startRuntime(id: string): Promise<RuntimeStatus>
  stopRuntime(id: string): Promise<RuntimeStatus>
  listLocalModels(): Promise<LocalModelEntry[]>
  browseModels(query?: string): Promise<ModelInfo[]>
  pullModel(req: PullRequest): Promise<{ pullId: string }>
  cancelPull(pullId: string): Promise<void>
  deleteLocalModel(runtime: string, modelId: string): Promise<void>
  onPullProgress(cb: (p: PullProgress & { pullId: string }) => void): () => void

  // Benchmarks
  runBenchmark(req: BenchmarkRequest): Promise<{ benchId: string }>
  cancelBenchmark(benchId: string): Promise<void>
  listBenchmarks(modelId?: string): Promise<BenchmarkResult[]>
  onBenchmarkProgress(
    cb: (p: { benchId: string; done: boolean; result?: BenchmarkResult; progress?: number }) => void
  ): () => void

  // Usage / cost
  getUsage(): Promise<UsageSummary>

  // Developer / logs
  getLogs(limit?: number): Promise<LogEntry[]>
  exportLogs(): Promise<string>

  // Window controls (frameless window chrome)
  windowMinimize(): Promise<void>
  windowToggleMaximize(): Promise<boolean>
  windowClose(): Promise<void>
  windowIsMaximized(): Promise<boolean>

  // Workspace
  pickWorkspace(): Promise<string | null>
}

/** IPC channel names (invoke) — kept in one place for main + preload. */
export const IPC = {
  listProviders: 'providers:list',
  saveProvider: 'providers:save',
  deleteProvider: 'providers:delete',
  testProvider: 'providers:test',
  listModels: 'providers:models',
  startChat: 'chat:start',
  cancelChat: 'chat:cancel',
  chatEvent: 'chat:event',
  resolvePermission: 'chat:resolve-permission',
  listConversations: 'conv:list',
  getConversation: 'conv:get',
  createConversation: 'conv:create',
  updateConversation: 'conv:update',
  deleteConversation: 'conv:delete',
  searchConversations: 'conv:search',
  exportConversation: 'conv:export',
  importConversation: 'conv:import',
  listPresets: 'preset:list',
  savePreset: 'preset:save',
  deletePreset: 'preset:delete',
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  scanHardware: 'hw:scan',
  analyzeModels: 'hw:analyze',
  listRuntimes: 'local:runtimes',
  startRuntime: 'local:runtime-start',
  stopRuntime: 'local:runtime-stop',
  listLocalModels: 'local:models',
  browseModels: 'local:browse',
  pullModel: 'local:pull',
  cancelPull: 'local:pull-cancel',
  deleteLocalModel: 'local:delete',
  pullProgress: 'local:pull-progress',
  runBenchmark: 'bench:run',
  cancelBenchmark: 'bench:cancel',
  listBenchmarks: 'bench:list',
  benchmarkProgress: 'bench:progress',
  getUsage: 'usage:get',
  getLogs: 'logs:get',
  exportLogs: 'logs:export',
  windowMinimize: 'win:minimize',
  windowToggleMaximize: 'win:toggle-maximize',
  windowClose: 'win:close',
  windowIsMaximized: 'win:is-maximized',
  pickWorkspace: 'workspace:pick'
} as const
