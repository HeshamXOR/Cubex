import type { RetryPolicy, TimeoutConfig } from '@core/types'
import { DEFAULT_RETRY_POLICY, DEFAULT_TIMEOUT_CONFIG } from '@core/types'
import type { ShellId } from './ipc'
import { DEFAULT_COMPACTION_THRESHOLD } from './contextPolicy'
import { DEFAULT_PEER_SETTINGS, type PeerSettings } from './peers'
import { DEFAULT_UPDATE_SETTINGS, type UpdateSettings } from './updates'

export type ThemeMode = 'dark' | 'light' | 'system'

/** An external Model Context Protocol server the user has configured. */
export interface McpServerConfig {
  id: string
  name: string
  /** Executable to spawn (stdio transport). */
  command: string
  args?: string[]
  /** Variables added to the server's environment, as typed. Anything that is a credential belongs in `secretEnv`. */
  env?: Record<string, string>
  /** Variable name to the credential reference its value is stored under. The value itself lives in the OS credential store, never in settings. */
  secretEnv?: Record<string, string>
  enabled: boolean
}

/** A lifecycle hook: a shell command run on a harness event. */
export interface HookConfig {
  id: string
  event: 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop'
  /** Tool-name substring to match (empty = all tools / events). */
  matcher?: string
  command: string
  enabled: boolean
}

export interface AppSettings {
  general: {
    theme: ThemeMode
    language: string
    startMaximized: boolean
    /** The folder/project Cubex is scoped to (shown to the model as context). */
    workspacePath?: string
    /** Recently opened project folders (most-recent first), for the switcher. */
    recentWorkspaces?: string[]
  }
  appearance: {
    /** Accent hex for selection and primary actions. */
    accent: string
    /** UI font family key. */
    font: 'inter' | 'system' | 'geist' | 'mono'
    /** UI scale / density. */
    density: 'comfortable' | 'compact'
    /** Corner rounding. */
    radius: 'sharp' | 'default' | 'round'
  }
  ai: {
    defaultProviderId?: string
    defaultModel?: string
    /** Tokens one reply may run to. 0 is Automatic: up to 32,000, or what the model can write if that is less (see outputLimit.ts). */
    maxOutputTokens: number
    retry: RetryPolicy
    fallbackEnabled: boolean
    /**
     * `requestMs` is how long to wait for a response to begin, `streamIdleMs` how long one that has begun may go
     * quiet, and `totalMs` an optional hard ceiling (0 = none). Minutes of waiting are normal on a slow provider,
     * so a request is only cut when it is stuck. Read through `resolveTimeouts`.
     */
    timeout: TimeoutConfig
    /**
     * The older key for `compaction.auto`. Both are kept equal on every save, and
     * `compaction.auto` wins when they ever differ (see contextPolicy.ts).
     */
    autoCompact: boolean
    compaction?: CompactionSettings
    budget?: BudgetSettings
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
  /** External MCP servers (stdio) whose tools are offered to the model. */
  mcpServers?: McpServerConfig[]
  /** Lifecycle hooks — shell commands run on tool/prompt events. */
  hooks?: HookConfig[]
  /** Compiler feedback the model receives after it edits a file. */
  diagnostics?: DiagnosticsSettings
  /** Preferred shell for running commands. */
  shell?: ShellSettings
  /** When Cubex shows a desktop notification (notify-files). */
  notifications?: NotificationSettings
  /** Other agents the model may consult: programs and models, and how long a conversation with one may run. */
  peers?: PeerSettings
  /** Whether Cubex looks for new versions, and the one version the person skipped. */
  updates?: UpdateSettings
  /** About the stored file itself, not a preference. */
  meta?: SettingsMeta
}

export interface SettingsMeta {
  /** Which one-time rewrites of the stored file have run (see `migrate` in main/config.ts). Missing means none. */
  schemaVersion: number
}

/** Bump when stored settings need a one-time rewrite, and add the step to `migrate` in main/config.ts. */
export const SETTINGS_SCHEMA_VERSION = 1

/** Spend caps in US dollars. A missing cap is no cap; the action applies to all of them. */
export interface BudgetSettings {
  /** What one user turn (all of its model requests) may cost. */
  perTurnUsd?: number
  /** What one session (task) may cost in total. */
  perSessionUsd?: number
  /** What one local calendar day may cost across every session. */
  dailyUsd?: number
  /** `warn` notices at 80 and 100 percent and keeps going; `stop` ends the turn at 100 percent. Default `warn`. */
  action?: 'warn' | 'stop'
}

/** How the context window is kept from filling. Read through `resolveCompactionPolicy`, never directly. */
export interface CompactionSettings {
  /** Summarize older messages automatically. Same switch as `ai.autoCompact`. */
  auto?: boolean
  /** Share of the usable input budget at which summarizing starts, 0.5 to 0.95. Default 0.8. */
  threshold?: number
  /** Replace old tool output with short stubs during a long turn. Default on. */
  prune?: boolean
}

export interface DiagnosticsSettings {
  /**
   * `errors`: append the new compiler errors of an edited TypeScript or JavaScript file to the edit tool's
   * result (only in a project with a tsconfig.json or jsconfig.json). `off`: never run the checker.
   */
  afterEdit: 'off' | 'errors'
}

/** Native notifications for the moments a session needs the person or ends while they are elsewhere. */
export interface NotificationSettings {
  /** The master switch. Off means no toast, no taskbar flash and no badge. */
  enabled: boolean
  /** A session is waiting for an approval, an answer or a plan review. */
  needsMe: boolean
  /** A turn finished. */
  finished: boolean
  /** A turn stopped with an error. Stopping a turn yourself never notifies. */
  failed: boolean
  /** Stay quiet while Cubex is the window in front. Off also notifies about other sessions than the one on screen. */
  onlyInBackground: boolean
  sound: boolean
}

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  enabled: true,
  needsMe: true,
  finished: true,
  failed: true,
  onlyInBackground: true,
  sound: false
}

export const DEFAULT_SETTINGS: AppSettings = {
  general: { theme: 'dark', language: 'en', startMaximized: false },
  appearance: { accent: '#4f6cff', font: 'system', density: 'comfortable', radius: 'default' },
  ai: {
    maxOutputTokens: 0,
    retry: DEFAULT_RETRY_POLICY,
    fallbackEnabled: false,
    timeout: { ...DEFAULT_TIMEOUT_CONFIG },
    autoCompact: true,
    // No `auto` here on purpose: an install that only has the older autoCompact key keeps its choice.
    compaction: { threshold: DEFAULT_COMPACTION_THRESHOLD, prune: true }
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
  developer: { debugMode: false, rawRequestLogging: false },
  mcpServers: [],
  hooks: [],
  diagnostics: { afterEdit: 'errors' },
  shell: { preferred: 'auto' },
  notifications: DEFAULT_NOTIFICATIONS,
  peers: DEFAULT_PEER_SETTINGS,
  updates: DEFAULT_UPDATE_SETTINGS,
  meta: { schemaVersion: SETTINGS_SCHEMA_VERSION }
}

export interface ShellSettings {
  preferred?: ShellId | 'auto'
}
