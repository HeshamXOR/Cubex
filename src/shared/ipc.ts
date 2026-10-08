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
  ReasoningEffort,
  RoutingPolicy,
  SamplingParams,
  SystemProfile,
  Usage,
  ValidationResult
} from '@core/types'
import type { AppSettings } from './settings'
import type { HookTestRequest, HookTestResult, McpSecretForgetRequest, McpSecretSaveRequest, McpSecretSaveResult, McpServerStatus, McpTestRequest, McpTestResult } from './policy'
import type { ReadFileOptions, WorkspaceBrowseOptions, WorkspaceFileResult, WorkspaceListing, WorkspacePathStat } from './workspaceFile'
import type { PeerActivity, PeerConfig, PeerTestResult, PeersOverview } from './peers'
import type { UpdateInstallRequest, UpdateInstallResult, UpdateState } from './updates'

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
  /** Bounded display transcript; never replayed as provider tool-call protocol. */
  uiTranscriptJson?: string
  error?: NormalizedAIErrorData
}

/**
 * What the composer held for one conversation, next to its provider and model, so that each chat keeps its own
 * choices. The permission mode is left out on purpose: a chat left in a looser mode should not reopen in it.
 */
export interface ConversationComposer {
  /** Absent is the model's default. */
  effort?: ReasoningEffort
  longContext?: boolean
  /** The cap on one answer, in tokens. 0 is Automatic. */
  maxTokens?: number
  /** Ids of the other agents the model may ask in this chat (see shared/peers.ts). */
  peers?: string[]
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
  composer?: ConversationComposer
  /** Project folder this conversation belongs to (sidebar grouping). */
  workspacePath?: string
  /** Pinned to the top of the sidebar. */
  pinned?: boolean
  /** Archived — hidden from the main list, kept in the Archived section. */
  archived?: boolean
  /** First user message included in model context; the full transcript stays stored. */
  contextStartMessageId?: string
  /**
   * Generated summary of the messages before `contextStartMessageId`, sent as the
   * first message of every request. Cleared whenever the boundary is cleared.
   */
  contextSummary?: string
  /** Epoch milliseconds when `contextSummary` was generated. */
  contextSummaryAt?: number
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
  workspacePath?: string
  pinned?: boolean
  archived?: boolean
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

/**
 * Where a cost figure came from: the provider's own bill (`reported`), a price synced
 * from the model catalog, a price the user entered, or a built-in or missing price.
 */
export type CostSource = 'reported' | 'catalog' | 'user' | 'estimated'

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
  /** Absent on rows saved before cost sources existed; read those as 'estimated'. */
  costSource?: CostSource
  /** The conversation (task) the request belongs to, when known. */
  conversationId?: string
  /** Subset of inputTokens served from the provider's prompt cache. */
  cacheReadTokens?: number
  /** Subset of inputTokens written to the provider's prompt cache. */
  cacheWriteTokens?: number
}

export interface UsageSummary {
  today: number
  week: number
  month: number
  currency: string
  byProvider: Record<string, number>
  byModel: Record<string, number>
}

/** One line of the usage breakdown: a provider or a model. */
export interface UsageRow {
  /** The provider id, or the model id. */
  id: string
  /** On a model row: the provider that served most of it. */
  providerId?: string
  costUsd: number
  requests: number
  /** Input plus output tokens. */
  tokens: number
  /** Part of this cost comes from a built-in price, not a provider bill or a synced or entered price. */
  estimated?: boolean
  /** Some requests had no price data and count as $0. */
  unpriced?: boolean
  /** Runs on this PC, so there is no API cost. */
  local?: boolean
}

export interface UsagePeriod {
  costUsd: number
  requests: number
  tokens: number
  /** Highest cost first. */
  byProvider: UsageRow[]
  byModel: UsageRow[]
}

/** A spend against one cap of `ai.budget`. Only caps that are set have a meter. */
export interface BudgetMeter {
  scope: BudgetScope
  limitUsd: number
  spentUsd: number
  state: BudgetState
}

/** Spend by local calendar day, for the usage popover and the budget settings. Costs are estimates unless a row says otherwise. */
export interface UsageReport {
  generatedAt: number
  /** Since local midnight. */
  today: UsagePeriod
  /** The last 7 local days, today included. */
  week: UsagePeriod
  /** The last 30 local days, today included. */
  month: UsagePeriod
  budget: {
    action: 'warn' | 'stop'
    /** One per cap that is set and has a spend to compare. */
    meters: BudgetMeter[]
    /** What the day, the open task and its running turn have cost, whether or not a cap is set for them. */
    spent: { daily: number; session?: number; turn?: number }
  }
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

/** Coarse stage of a download, so a view can pick its wording without parsing `status`. */
export type PullPhase = 'queued' | 'preparing' | 'downloading' | 'verifying' | 'finalizing' | 'done' | 'error' | 'cancelled'

/** Why a download failed, so a view can offer the right next step. */
export type PullErrorCode = 'runtime_unreachable' | 'disk_space' | 'unsupported' | 'failed'

export interface PullProgress {
  modelId: string
  status: string
  completedBytes?: number
  totalBytes?: number
  speedBps?: number
  etaSeconds?: number
  done: boolean
  error?: string
  /** The runtime doing the download (for example 'ollama'). */
  runtime?: string
  phase?: PullPhase
  /** 1-based place in the line while another download holds the runtime: 1 means next up. */
  queuePosition?: number
  /** The file being fetched when a model is made of several parts. */
  fileName?: string
  fileIndex?: number
  fileCount?: number
  /** Whole seconds since the last byte arrived; present only once the download has stalled. */
  stalledForSeconds?: number
  errorCode?: PullErrorCode
}

export interface ModelCompatibility extends CompatibilityResult {
  model: ModelInfo
}

/** The outcome of asking a provider for its model list again. A failure keeps the models already known. */
export interface ModelRefreshResult {
  ok: boolean
  /** How many models the provider offers now (or, after a failure, the last known count). */
  count: number
  message?: string
  /** What to try next, set with a failure. */
  fix?: string
}

// ---------------------------------------------------------------------------
// Chat streaming
// ---------------------------------------------------------------------------

/**
 * Tool permission posture for a turn, mirroring Claude Code:
 *  - default:     mutating tools (write_file) ask for approval each time
 *  - acceptEdits: file edits are auto-approved; other asks still prompt
 *  - plan:        read-only — no edits/mutations; the model must present a plan
 *  - bypass:      never prompt; every tool runs (use with care)
 */
/** One entry in the workspace file tree (sidebar explorer). */
export interface DirEntry {
  name: string
  /** Path relative to the workspace root, POSIX-style separators. */
  path: string
  isDirectory: boolean
  /** A dot-name or an ignored folder such as node_modules: only listed when the caller asks for hidden entries. */
  hidden?: boolean
}

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypass'

export interface ChatStartRequest {
  /** Renderer-allocated stream id lets listeners attach before any early events. */
  streamId?: string
  conversationId: string
  /** The user message id that started this turn (for file rewind). */
  messageId?: string
  policy: RoutingPolicy
  systemPrompt?: string
  /** The new user message text (attachments referenced by id). */
  userText: string
  attachmentIds?: string[]
  /** Register the built-in subagent delegation tool for this turn. */
  subagentEnabled?: boolean
  /** Register workspace-scoped file tools (read/list/search/write). */
  fileToolsEnabled?: boolean
  /** Tool permission posture for this turn (defaults to 'default'). */
  permissionMode?: PermissionMode
  /** Opt into a provider's 1M-context beta (for gated long-context models). */
  longContext?: boolean
  /** Ids of the other agents this chat turned on. Only agents that exist and are on in settings are offered to the model. */
  peers?: string[]
  /** Attachments (image/file content parts) to include with the user message. */
  attachments?: MessageContentPart[]
  /**
   * A skill the person picked by name in the composer. Its instructions go in front of `userText` for this turn, so
   * the model does not have to decide to load it. The name is looked up in the task's skills, never read from a path.
   */
  skill?: string
}

/** Lifecycle of a single tool invocation, for the in-thread activity cards. */
/** One file changed by a multi-file tool call. A move is a `deleted` source plus an `added` destination. */
export interface ToolFileActivity {
  /** Workspace-relative path with forward slashes. */
  path: string
  status: 'added' | 'modified' | 'deleted'
  added: number
  removed: number
  /** Condensed inline diff, same format as ToolActivity.diff; omitted when there is nothing to show. */
  diff?: string
}

/** One compiler error in a file the agent edited, for the post-edit feedback and the Problems list. */
export interface DiagnosticItem {
  /** Workspace-relative path with forward slashes. */
  path: string
  /** 1-based position of the start of the error. */
  line: number
  col: number
  /** The compiler's code, e.g. "TS2322". */
  code?: string
  /** Absent means an error. */
  severity?: 'error' | 'warning'
  /** One line of text, as shown to the model. */
  message: string
}

/** New problems in one file of an edit that changed several. */
export interface DiagnosticFileCount {
  /** Workspace-relative path with forward slashes. */
  path: string
  errors: number
  warnings: number
}

/** Error and warning counts of the new diagnostics an edit introduced (a count chip in the UI). */
export interface DiagnosticsSummary {
  errors: number
  warnings: number
  /** The first of the new errors, in file order (at most 15 per edit); what the chip expands to. */
  items?: DiagnosticItem[]
  /** Counts per file, only when the edit changed more than one file (apply_patch); the totals above cover all of them. */
  files?: DiagnosticFileCount[]
}

/** Whether post-edit diagnostics can run, and with which engine. `reason` explains an unavailable or limited checker. */
export interface DiagnosticsStatus {
  available: boolean
  engine?: 'typescript'
  version?: string
  reason?: string
}

export interface ToolActivity {
  id: string
  name: string
  /** `queued`: the model asked for it; gating/execution has not started yet. */
  phase: 'queued' | 'running' | 'done' | 'error'
  /** The application closed or the turn ended before completion was recorded. */
  interrupted?: boolean
  /** Short human title, e.g. "Edit src/app.ts" or "Read README.md". */
  title?: string
  /** One-line detail / result summary. */
  detail?: string
  /** Diff stats for edit/write tools. */
  added?: number
  removed?: number
  /** Serialized inline diff (one line per entry, tag as first char) for edits. */
  diff?: string
  /**
   * Per-file changes of a multi-file tool call (apply_patch), in patch order. The activity's
   * top-level `added`/`removed` are the totals across these entries. Single-file tools omit it.
   */
  files?: ToolFileActivity[]
  /**
   * New compiler errors this edit introduced, when the checker ran in time. Absent means unknown or clean:
   * the checker stays silent on timeouts, so never read an absent value as "no errors".
   */
  diagnostics?: DiagnosticsSummary
  /** Saved command output, retrieved using its owning task rather than a path. */
  outputId?: string
  outputConversationId?: string
  /** Set on a run_command that started a background task and on the task_* calls; matches BackgroundTask.id. */
  taskId?: string
  /** Set on a finished consult_agent call: who was asked, which message of the talk it was, and the verdict. */
  peer?: PeerActivity
}

export interface CommandOutputArtifact {
  id: string
  conversationId: string
  command: string
  createdAt: number
  completedAt?: number
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted'
  capturedBytes: number
  totalBytes?: number
  truncated: boolean
  exitCode?: number
  signal?: string
  error?: string
}

export interface CommandOutputPage {
  artifact: CommandOutputArtifact
  text: string
  /** Byte offsets; callers must use nextOffset to avoid splitting UTF-8. */
  offset: number
  nextOffset?: number
  eof: boolean
}

/** Shells run_command can use. `posix` is /bin/sh on macOS and Linux. */
export type ShellId = 'git-bash' | 'pwsh' | 'powershell' | 'cmd' | 'posix'

/** A long-running command started with run_command { background: true }. ChatEvent kind 'task' upserts by id. */
export interface BackgroundTask {
  /** 'p_' plus six characters, e.g. 'p_k3j9a2'. */
  id: string
  conversationId: string
  command: string
  shell: ShellId
  cwd: string
  status: 'running' | 'exited' | 'failed' | 'killed' | 'timed_out'
  startedAt: number
  endedAt?: number
  exitCode?: number
  pid?: number
  /** A CommandOutputArtifact id; read it with readCommandOutput(task.conversationId, task.outputId). */
  outputId: string
  /** Set once the output shows the server is up (a localhost URL, "listening on", "ready in", ...). */
  readyHint?: { url?: string; port?: number; line: string }
}

/** A rule that pre-approves one class of tool call inside one project ("Always allow npm test"). */
export interface PermissionRule {
  id: string
  /** Absolute workspace root the rule applies to. */
  workspace: string
  /** Tool the rule matches, e.g. run_command, edit_file, web_fetch, mcp__server__tool. */
  tool: string
  /** Tool-specific matcher: a command prefix for run_command, a host for web_fetch, '*' for every call of the tool. */
  pattern: string
  /** Short label for the approval card and Settings, e.g. "npm test". */
  label: string
  createdAt: number
}

/** `always` allows this call and saves the ask's suggested rule for its project. */
export type PermissionDecision = 'allow' | 'deny' | 'always'

/** A permission request surfaced to the user before a tool runs. */
export interface PermissionAsk {
  id: string
  toolName: string
  title: string
  detail?: string
  /** Why this call needs a human, e.g. a protected path or an outbound host. */
  risks?: string[]
  /** Suggested project-scoped rule for "Always allow"; absent when the call cannot be generalized safely. */
  rule?: Pick<PermissionRule, 'tool' | 'pattern' | 'label'>
}

/** A workspace file a conversation changed, net of all its turns (for the review panel). */
export interface SessionFileChange {
  /** Workspace-relative POSIX path. */
  path: string
  status: 'added' | 'modified' | 'deleted'
  added: number
  removed: number
  /** Line diff from the pre-conversation snapshot to the current file (ToolActivity.diff format). */
  diff: string
  /** The file on disk no longer matches what Cubex last wrote (it was edited elsewhere). */
  externallyModified?: boolean
  /** Last time Cubex wrote this file. */
  updatedAt: number
}

export interface SessionRevertResult {
  /** Workspace-relative paths restored to their pre-conversation state. */
  restored: string[]
  /** Files left untouched, with a user-facing reason. */
  skipped: Array<{ path: string; reason: string }>
  /** Present when the restore can be undone with `undoRevert`; valid until the next user message is sent. */
  revertId?: string
}

/** Which parts of the point before a user message to go back to. */
export interface RestoreAxes {
  /** Put the files that message's turn and the later ones changed back. */
  code: boolean
  /** Remove that message and everything after it from the conversation. */
  conversation: boolean
}

/** What going back to just before a user message would change. Asking changes nothing. */
export interface RestorePreview {
  /** False when no file checkpoint exists for the message: Cubex restarted since, or its turn had no file tools. */
  checkpoint: boolean
  /** Files a restore would change. Workspace-relative POSIX paths (absolute for a file outside the workspace). */
  files: Array<{ path: string; action: 'revert' | 'delete' | 'recreate' }>
  /** Files a restore would leave as they are because they changed outside Cubex, with why. */
  blocked: Array<{ path: string; reason: string }>
}

export interface RestoreResult {
  /** Files put back, as paths relative to the workspace. */
  restored: string[]
  /** Files left as they are because they changed outside Cubex, with why. */
  skipped: Array<{ path: string; reason: string }>
  /** Files that could not be written. When there are any the conversation is left whole so the restore can be retried. */
  failed: Array<{ path: string; reason: string }>
  /** Present when the conversation was cut back. */
  conversation?: {
    removedMessages: number
    /** Plans made in the removed turns; they were deleted with them. */
    removedPlanIds: string[]
    /** The summary of earlier messages described turns that are gone, so it was dropped. */
    contextCleared: boolean
  }
  /** Present when the restore can be undone with `undoRestore`; valid until the next user message is sent. */
  undoId?: string
}

export interface RestoreUndoResult {
  /** Files put back as the restore found them, as paths relative to the workspace. */
  restored: string[]
  /** True when the removed messages, plans and summary were put back too. */
  conversation: boolean
}

/** One change region of a file, with 3 lines of context. Ids are stable across unrelated edits above the hunk. */
export interface ReviewHunk {
  /** sha1 of the path plus the hunk body without line numbers. */
  id: string
  /** '@@ -10,5 +10,6 @@' */
  header: string
  /** 1-based; when a count is 0 the start is the line before the gap (0 at the top of the file), as in git. */
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** Each line prefixed with ' ' (context), '+' (added) or '-' (removed); no line endings, no BOM. */
  lines: string[]
  /** 'accepted' only while the file still has the content it was accepted against. */
  state: 'pending' | 'accepted'
}

export interface ReviewFile {
  /** Workspace-relative POSIX path. */
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  added: number
  removed: number
  /** sha256 of the file's current bytes (null when it is absent): what these hunks were computed against. */
  headHash: string | null
  /** Empty for binary, oversize and (when the old content was not kept) unrecoverable files: review those per file. */
  hunks: ReviewHunk[]
  binary?: boolean
  oversize?: boolean
  externallyModified?: boolean
  /** Last time Cubex wrote this file. */
  updatedAt?: number
  /** Only the line endings or the byte-order mark differ, so there are no hunks to show. */
  formatChanged?: boolean
  /** The file has more hunks than the 200 returned; the rest can only be reviewed per file. */
  hunksOmitted?: number
}

export type ReviewScope =
  /** Everything changed from the start of that user message's turn until now. */
  | { kind: 'turn'; messageId: string }
  /** Pre-task state to now. */
  | { kind: 'session' }
  /** Working tree against HEAD (untracked files included). */
  | { kind: 'uncommitted' }
  /** Working tree against the merge base with `base`. */
  | { kind: 'branch'; base: string }

export interface ReviewComment {
  id: string
  /** Workspace-relative POSIX path. */
  path: string
  /** 1-based inclusive line range on the chosen side of the diff. */
  startLine: number
  endLine: number
  side: 'old' | 'new'
  hunkId?: string
  text: string
}

export interface HunkRevertResult {
  /** Hunk ids that were reverted. */
  applied: string[]
  conflicts: Array<{ hunkId: string; reason: 'drift' | 'context_mismatch' }>
  /** sha256 of the file after the revert (null when it is absent). */
  newHeadHash: string | null
  /** Undo handle; absent when nothing was applied. Valid until the next user message is sent. */
  revertId?: string
  /**
   * Hunks that were applied although the file no longer matched what the UI rendered, or
   * with relaxed context. Show them and offer Undo; they were never applied silently.
   */
  fuzzy?: Array<{ hunkId: string; fuzz: number; offset: number; drift: boolean }>
}

/** Read-only git facts about a task's workspace (title bar and review panel). */
export interface WorkspaceGitStatus {
  isRepo: boolean
  /** Current branch; absent when HEAD is detached. */
  branch?: string
  /** Short commit id of HEAD. */
  head?: string
  ahead?: number
  behind?: number
  /** Files with uncommitted changes, including untracked. */
  changedFiles: number
  /** True when changedFiles is not a real count (git status was skipped for safety or did not finish); show the branch only. */
  changedFilesUnknown?: boolean
}

/** What the review panel sends to commit selected files (gitCommit). */
export interface GitCommitRequest {
  /** 1 to 2000 characters; the first line is the subject. */
  message: string
  /** 1 to 200 workspace-relative paths. Only these are committed; the user's other staged work stays staged. */
  paths: string[]
}

export type GitCommitResult =
  /** commit is the abbreviated hash; summary is the subject line, then a one-line change count. */
  | { ok: true; commit: string; summary: string }
  /** error is a plain sentence, or the output of the hook that rejected the commit. */
  | { ok: false; error: string }

/** A structured question the model asks the user mid-turn (ask_user_question). */
export interface QuestionAsk {
  id: string
  question: string
  options: Array<{ label: string; description?: string }>
  /** Allow selecting more than one option. */
  multiSelect?: boolean
  /** Offer a free-text "Other" answer. */
  allowOther?: boolean
}

/** How the user resolved an exit_plan_mode approval card. */
export type PlanDecision = 'reject' | 'default' | 'acceptEdits' | 'bypass'

export type PlanStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'
export const PLAN_MAX_FEEDBACK_LENGTH = 8000

/** A plan the model presents for approval (exit_plan_mode), Claude-Code style. */
export interface PlanAsk {
  id: string
  /** The proposed implementation plan (markdown). */
  plan: string
  title?: string
  /** Harness-generated Markdown artifact; never a model-selected path. */
  path?: string
  createdAt?: number
  conversationId?: string
  status?: PlanStatus
  decision?: PlanDecision
  feedback?: string
  resolvedAt?: number
}

/** One item in the model-managed task checklist (`todo_write`). */
export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  /** Present-continuous label shown while this item is in progress. */
  activeForm?: string
}

/** Estimated contribution to the last model request, not a tokenizer measurement. */
export interface ContextUsageDetail {
  id: string
  label: string
  estimatedTokens: number
  count?: number
  /** UTF-16 character count of the text/schema being estimated. */
  characters?: number
}

export interface ContextUsageSection extends ContextUsageDetail {
  id: 'system' | 'conversation' | 'toolResults' | 'tools' | 'mcp' | 'attachments'
  details?: ContextUsageDetail[]
}

export interface ContextUsageSnapshot {
  sections: ContextUsageSection[]
  /** Heuristic size of the request, and the sum of the section rows. */
  estimatedTokens: number
  /**
   * What the context is actually believed to hold, and the number the meter
   * should show: `contextTokens ?? estimatedTokens`. Equals `estimatedTokens`
   * until the provider reports an input count for this task; after that it is
   * that count plus an estimate of only what was appended since, so it is
   * consistently closer to the truth. Always set by the main process; optional
   * only so older snapshots and fixtures stay valid.
   */
  contextTokens?: number
  /** Which measurement `contextTokens` rests on. 'estimated' is the weaker one. */
  contextBasis?: 'anchored' | 'estimated'
  /** The reported input count the anchor rests on. Only when anchored. */
  anchorTokens?: number
  /** Estimated tokens appended since that report. Only when anchored. */
  appendedTokens?: number
  contextWindow?: number
  /** The window minus the reserved output and a safety margin: what the request may fill. */
  inputBudget?: number
  outputReserve: number
  /** False means the provider chooses an unspecified output limit. */
  outputReserveKnown?: boolean
  /** Provider-reported input for this request; never summed across tool iterations. */
  measuredInputTokens?: number
  /** Binary/remote media costs are unavailable and excluded from the estimate. */
  attachmentEstimateIncomplete?: boolean
  provider?: string
  model?: string
  updatedAt: number
}

/**
 * What one summary changed, in the estimator's tokens: the messages it replaced against the summary that
 * stands in for them. System instructions and tool definitions are the same either way and are not counted.
 */
export interface CompactionStats {
  /** Messages before the new boundary, all of which the summary now stands in for. */
  messagesSummarized?: number
  tokensBefore?: number
  tokensAfter?: number
}

/** Outcome of `compactConversation`. On failure the conversation is left exactly as it was. */
export type CompactionResult =
  | ({ ok: true; summary: string; boundaryMessageId: string } & CompactionStats)
  | { ok: false; error: string }

/**
 * One step of keeping the context from filling, as it happens inside a turn: summarizing older messages
 * (`summarize`) or replacing old tool output with stubs (`prune`). Summarizing also sends the older
 * `compacted` event once the summary is saved; this one carries the progress and the numbers.
 */
export interface CompactionEvent extends CompactionStats {
  step: 'summarize' | 'prune'
  phase: 'started' | 'completed' | 'failed'
  summary?: string
  boundaryMessageId?: string
  /** `prune`: tool results replaced with stubs, and the tokens that freed. */
  resultsTrimmed?: number
  tokensFreed?: number
  /** `failed`: what happened, as a sentence. */
  error?: string
}

export type BudgetScope = 'turn' | 'session' | 'daily'

/** Where a spend sits against its cap: ok below 80 percent, warn from 80, over from 100. */
export type BudgetState = 'ok' | 'warn' | 'over'

/** Spend reached a threshold of a cap in `ai.budget`. Raised once per crossing; a stop is raised every time it ends a turn. */
export interface BudgetNotice {
  scope: BudgetScope
  /** `warn`: 80 percent of the cap. `over`: the cap itself. */
  level: 'warn' | 'over'
  action: 'warn' | 'stop'
  spentUsd: number
  limitUsd: number
  /** The turn ended before its next request because of this notice. */
  stopped: boolean
  /** What happened and how to fix it, ready to show. */
  message: string
}

/** Main assigns a per-stream sequence before IPC; optional only for legacy fixtures. */
export type ChatEvent = {
  sequence?: number
  conversationId?: string
  parentMessageId?: string
} & (
  | { streamId: string; kind: 'stream'; event: AIStreamEvent }
  | { streamId: string; kind: 'gateway'; event: GatewayEvent }
  | { streamId: string; kind: 'tool'; tool: ToolActivity }
  | { streamId: string; kind: 'permission'; ask: PermissionAsk }
  | { streamId: string; kind: 'question'; ask: QuestionAsk }
  | { streamId: string; kind: 'todos'; todos: TodoItem[] }
  | { streamId: string; kind: 'plan'; ask: PlanAsk }
  | { streamId: string; kind: 'mode'; mode: PermissionMode }
  | { streamId: string; kind: 'context'; context: ContextUsageSnapshot }
  | { streamId: string; kind: 'iteration'; iteration: number }
  /** Older turns were summarized automatically before this turn's request; already saved on the conversation. */
  | { streamId: string; kind: 'compacted'; summary: string; boundaryMessageId: string }
  /** The review state of this task changed (a file was written, a hunk reverted or accepted); refetch with getReview. */
  | { streamId: string; kind: 'review'; revision: number }
  /** A turn the main process started on the user's behalf (review comments): show this user message and attach to the stream. */
  | { streamId: string; kind: 'userMessage'; messageId: string; text: string }
  /** A background task started or changed state; upsert by task.id. Also pushed when the user stops one. */
  | { streamId: string; kind: 'task'; task: BackgroundTask }
  /** Context management (context-cost): a summarize or prune step started, finished or failed inside this turn. */
  | { streamId: string; kind: 'compaction'; compaction: CompactionEvent }
  /** Spend reached 80 or 100 percent of a budget cap; with action `stop` the turn ends before its next request. */
  | { streamId: string; kind: 'budget'; budget: BudgetNotice }
)

export interface PullRequest {
  runtime: string
  modelId: string
}

export interface BenchmarkRequest {
  config: BenchmarkConfig
}

/** Discoverable instructions. Bodies are fetched separately, never included in a list. */
export interface SkillSummary {
  name: string
  description: string
  source: 'bundled' | 'cubex' | 'agents' | 'claude'
  path: string
}

export interface SkillDocument extends SkillSummary {
  content: string
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
  resolvePermission(id: string, decision: PermissionDecision): Promise<void>
  /** Saved "Always allow" rules, optionally for one workspace. */
  listPermissionRules(workspace?: string): Promise<PermissionRule[]>
  removePermissionRule(id: string): Promise<void>
  /** Files this conversation changed, net of all turns, against their pre-conversation state. */
  getSessionChanges(conversationId: string): Promise<SessionFileChange[]>
  /** Restore changed files to their pre-conversation state; no paths means every file. */
  revertSessionChanges(conversationId: string, paths?: string[]): Promise<SessionRevertResult>
  /** Git facts for a task's workspace (or the selected workspace); null when there is none. */
  getGitStatus(conversationId?: string): Promise<WorkspaceGitStatus | null>
  /**
   * Commit exactly these files from the task's workspace, leaving the user's other staged work staged.
   * Hooks run and their output comes back in error when they reject the commit; it never pushes or amends.
   */
  gitCommit(conversationId: string, request: GitCommitRequest): Promise<GitCommitResult>
  /** A deterministic commit subject (imperative, at most 72 characters) built from the task's changed files; '' when it changed none. */
  gitSuggestMessage(conversationId: string): Promise<string>
  /**
   * Current compiler errors in the files this task edited (or in just `path`, workspace-relative), for a Problems list.
   * Empty when the checker is unavailable, times out or finds nothing; use getDiagnosticsStatus to tell them apart.
   */
  getDiagnostics(conversationId: string, path?: string): Promise<DiagnosticItem[]>
  /** Whether post-edit diagnostics can run for this task's workspace (or the last one used), and why not. */
  getDiagnosticsStatus(conversationId?: string): Promise<DiagnosticsStatus>
  /** Restore workspace files to their state before a given user message's turn. */
  rewindFiles(conversationId: string, messageId: string): Promise<{ restored: string[] }>
  /** Per-file hunks for a scope (turn: from that message's turn on; session; uncommitted; branch). Rejects with a clear error for a scope that is not supported. */
  getReview(conversationId: string, scope: ReviewScope): Promise<ReviewFile[]>
  /** Revert hunks against the file's CURRENT bytes; never overwrites silently (see HunkRevertResult). */
  revertHunks(conversationId: string, req: { path: string; hunkIds: string[]; expectHeadHash: string }): Promise<HunkRevertResult>
  /** Mark hunks accepted; each item is honored only while the file still has `headHash`. */
  markReviewed(conversationId: string, items: Array<{ path: string; hunkIds: string[]; headHash: string }>): Promise<void>
  /** Undo a file or hunk revert while the file still equals what the revert wrote and before the next user message. */
  undoRevert(conversationId: string, revertId: string): Promise<{ restored: string[] }>
  /**
   * Send the queued review comments as one structured user message and start a turn with the
   * settings of the last turn (or `options.request`). `options.streamId` lets listeners attach early.
   */
  sendReviewComments(conversationId: string, comments: ReviewComment[], options?: { streamId?: string; request?: Partial<ChatStartRequest> }): Promise<{ messageId: string; streamId: string; text: string }>
  /**
   * Go back to just before a user message: put the files its turn and the later ones changed back, drop that message
   * and everything after it, or both. Files changed outside Cubex are left as they are and listed. Refused while a turn
   * runs. A restore that can be undone carries `undoId` for `undoRestore`.
   */
  restoreCheckpoint(conversationId: string, messageId: string, axes: RestoreAxes): Promise<RestoreResult>
  /** Answer an ask_user_question raised during a chat turn (empty = dismissed). */
  resolveQuestion(id: string, answers: string[]): Promise<void>
  /** Resolve an exit_plan_mode approval (reject = keep planning; else the mode to switch into). */
  resolvePlan(id: string, decision: PlanDecision, feedback?: string): Promise<void>
  /** Persisted Markdown plan revisions, newest first. */
  listPlans(conversationId: string): Promise<PlanAsk[]>
  getPlan(id: string): Promise<PlanAsk | null>
  /** Reveal only an artifact owned by the plan store. */
  revealPlan(id: string): Promise<void>
  readCommandOutput(conversationId: string, id: string, offset?: number, limit?: number): Promise<CommandOutputPage>
  revealCommandOutput(conversationId: string, id: string): Promise<void>

  // Conversations
  listConversations(): Promise<ConversationSummary[]>
  getConversation(id: string): Promise<Conversation | null>
  createConversation(partial: Partial<Conversation>): Promise<Conversation>
  updateConversation(id: string, patch: Partial<Conversation>): Promise<void>
  /**
   * Summarize the older turns of a task into `contextSummary` and move
   * `contextStartMessageId` past them; the last two user turns stay verbatim and the
   * transcript is never changed. Refused while a turn is running.
   */
  compactConversation(conversationId: string): Promise<CompactionResult>
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

  // Skills (selected workspace, or the explicit task's own workspace)
  listSkills(conversationId?: string): Promise<SkillSummary[]>
  readSkill(name: string, conversationId?: string): Promise<SkillDocument>

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

  // Shell & background tasks
  listShells(): Promise<Array<{ id: ShellId; label: string; path: string; available: boolean }>>
  listTasks(conversationId?: string): Promise<BackgroundTask[]>
  stopTask(taskId: string): Promise<{ ok: boolean; error?: string }>
  sendTaskInput(taskId: string, input: string): Promise<{ ok: boolean; error?: string }>

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
  /** List a task's workspace (or the selected workspace when no task is supplied). */
  readWorkspaceDir(relPath: string, conversationId?: string): Promise<DirEntry[]>
  /** Fuzzy-search files under the workspace (for @-mention autocomplete). */
  searchWorkspaceFiles(query: string, limit?: number, conversationId?: string): Promise<DirEntry[]>
  /** Reveal a workspace file in the OS file manager. */
  revealPath(relPath: string, conversationId?: string): Promise<void>

  // Files and notifications (notify-files)
  /** Read one workspace file for the Files tab: capped text (it says when truncated), an image, or a note that the file is binary. */
  readWorkspaceFile(relPath: string, conversationId?: string, options?: ReadFileOptions): Promise<WorkspaceFileResult>
  /** One folder of the file tree. `showHidden` adds dot-names and ignored folders such as node_modules. */
  listWorkspaceDir(relPath: string, conversationId?: string, options?: WorkspaceBrowseOptions): Promise<WorkspaceListing>
  /** Find files by name or path. `showHidden` adds dot-files, never the inside of ignored folders. */
  findWorkspaceFiles(query: string, limit?: number, conversationId?: string, options?: WorkspaceBrowseOptions): Promise<DirEntry[]>
  /** Which of these paths exist in the workspace, with the canonical path to open for each. Anything outside it comes back missing. */
  statWorkspacePaths(paths: string[], conversationId?: string): Promise<WorkspacePathStat[]>
  /** Tell the main process which session the window shows (null for none), so it stays quiet about that one. */
  setActiveConversation(conversationId: string | null): Promise<void>
  /** A notification was clicked: show this session. */
  onOpenConversation(cb: (conversationId: string) => void): () => void
  /** Show a test notification, to check that the system lets Cubex through. */
  sendTestNotification(): Promise<{ shown: boolean; reason?: string }>

  // Restore and undo (restore-queue)
  /** What going back to just before a message would change, counted and listed. Changes nothing. */
  previewRestore(conversationId: string, messageId: string): Promise<RestorePreview>
  /** Undo the last restore of a task while its files still hold what the restore wrote and no message has been sent since. */
  undoRestore(conversationId: string, undoId: string): Promise<RestoreUndoResult>

  // MCP servers and hooks (policy-mcp)
  /**
   * Start an MCP server the way a turn would, list its tools and stop it again. A server that fails to
   * start is a result with `ok: false` and a reason; the promise rejects only for a malformed request.
   */
  testMcpServer(request: McpTestRequest): Promise<McpTestResult>
  /** The live connection state of every configured MCP server, in the order they are saved. */
  getMcpStatus(): Promise<McpServerStatus[]>
  /** Run one hook against a sample payload for its event and report what a real run would do with the result. */
  testHook(request: HookTestRequest): Promise<HookTestResult>

  // Spend and budgets (context-cost)
  /**
   * Spend by local calendar day (today, 7 days, 30 days) with provider and model breakdowns, and the
   * budget caps that are set against what this task (when given) and today have spent.
   */
  getUsageReport(conversationId?: string): Promise<UsageReport>

  // Providers (local-providers)
  /** Ask a provider for its model list again. A failure is a result, with what to try next; the promise rejects only for a malformed request. */
  refreshModels(providerId: string): Promise<ModelRefreshResult>

  // About (lead)
  /** Version, runtime and where Cubex keeps its files on this computer. */
  appInfo(): Promise<AppInfo>
  /** Open one of Cubex's folders in the file manager. Resolves to an empty string, or to what went wrong. */
  openAppFolder(kind: AppFolderKind): Promise<string>

  // MCP server environment (policy-mcp)
  /**
   * Keep one secret variable of a server in the operating system's credential store and get back the
   * reference to save in the server's settings. A refusal is a result with a reason; the value is never
   * returned or logged.
   */
  saveMcpSecret(request: McpSecretSaveRequest): Promise<McpSecretSaveResult>
  /** Delete the stored values of a server's secret variables, after they are removed or the server is. */
  forgetMcpSecrets(request: McpSecretForgetRequest): Promise<void>

  // Other agents
  /** Which of the saved agents can be used on this computer, and whether the programs the Add menu offers are installed. */
  getPeersStatus(): Promise<PeersOverview>
  /**
   * Send an agent a short test message the way a chat would and report what came back. The agent is the one on the
   * page, saved or not. A failure is a result with a reason; the promise rejects only for a malformed request.
   */
  testPeer(peer: PeerConfig): Promise<PeerTestResult>

  // Updates
  /** What is known about newer versions of Cubex. The first call also starts the periodic checks of a running copy. */
  getUpdateState(): Promise<UpdateState>
  /** Look for a newer version now. Resolves once GitHub has answered; a failed look is in the state, not a rejection. */
  checkForUpdates(): Promise<UpdateState>
  /** Download the installer of the update on offer and check it. Progress arrives through `onUpdateState`. */
  downloadUpdate(): Promise<UpdateState>
  /** Stop the download and delete what arrived. */
  cancelUpdateDownload(): Promise<UpdateState>
  /** Run the downloaded installer and quit. Refused while work is running, unless `force` is set. */
  installUpdate(request?: UpdateInstallRequest): Promise<UpdateInstallResult>
  /** Do not announce this version again. A newer one is announced. */
  skipUpdate(version: string): Promise<UpdateState>
  /** Open the page of the release on offer, in the browser. */
  openUpdatePage(): Promise<void>
  /** The update state changed: a look ended, a download moved on. Returns the unsubscribe function. */
  onUpdateState(cb: (state: UpdateState) => void): () => void
}

/** Facts about this installation, shown in Settings under About and used for bug reports. */
export interface AppInfo {
  version: string
  /** True for an installed build, false when running from source. */
  packaged: boolean
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  /** The operating system's own version string, for example "10.0.22631". */
  osRelease: string
  dataDir: string
  logsDir: string
}
export type AppFolderKind = 'data' | 'logs'

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
  listPermissionRules: 'permissions:list-rules',
  removePermissionRule: 'permissions:remove-rule',
  getSessionChanges: 'changes:list',
  revertSessionChanges: 'changes:revert',
  getGitStatus: 'workspace:git-status',
  gitCommit: 'git:commit',
  gitSuggestMessage: 'git:suggest-message',
  diagnosticsGet: 'diagnostics:get',
  diagnosticsStatus: 'diagnostics:status',
  rewindFiles: 'chat:rewind-files',
  reviewGet: 'review:get',
  reviewRevertHunks: 'review:revert-hunks',
  reviewMark: 'review:mark',
  reviewUndo: 'review:undo',
  reviewComments: 'review:comments',
  restoreCheckpoint: 'chat:restore-checkpoint',
  resolveQuestion: 'chat:resolve-question',
  resolvePlan: 'chat:resolve-plan',
  listPlans: 'plans:list',
  getPlan: 'plans:get',
  revealPlan: 'plans:reveal',
  readCommandOutput: 'command-output:read',
  revealCommandOutput: 'command-output:reveal',
  listConversations: 'conv:list',
  getConversation: 'conv:get',
  createConversation: 'conv:create',
  updateConversation: 'conv:update',
  compactConversation: 'conv:compact',
  deleteConversation: 'conv:delete',
  searchConversations: 'conv:search',
  exportConversation: 'conv:export',
  importConversation: 'conv:import',
  listPresets: 'preset:list',
  savePreset: 'preset:save',
  deletePreset: 'preset:delete',
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  listSkills: 'skills:list',
  readSkill: 'skills:read',
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
  pickWorkspace: 'workspace:pick',
  readWorkspaceDir: 'workspace:read-dir',
  searchWorkspaceFiles: 'workspace:search-files',
  revealPath: 'workspace:reveal',
  shellList: 'shell:list',
  tasksList: 'tasks:list',
  tasksStop: 'tasks:stop',
  tasksInput: 'tasks:input',
  // notify-files
  readWorkspaceFile: 'workspace:read-file',
  listWorkspaceDir: 'workspace:list-dir',
  findWorkspaceFiles: 'workspace:find-files',
  statWorkspacePaths: 'workspace:stat-paths',
  notifyActiveConversation: 'notify:active-conversation',
  notifyOpenConversation: 'notify:open-conversation',
  notifyTest: 'notify:test',
  // restore-queue
  restorePreview: 'chat:restore-preview',
  restoreUndo: 'chat:restore-undo',
  // policy-mcp
  mcpTest: 'mcp:test',
  mcpStatus: 'mcp:status',
  hooksTest: 'hooks:test',
  // context-cost
  getUsageReport: 'usage:report',
  // local-providers
  refreshModels: 'providers:refresh-models',
  // about
  appInfo: 'app:info',
  openAppFolder: 'app:open-folder',
  // policy-mcp: server environment
  mcpSaveSecret: 'mcp:save-secret',
  mcpForgetSecrets: 'mcp:forget-secrets',
  // other agents
  peersStatus: 'peers:status',
  peersTest: 'peers:test',
  // updates
  updatesGet: 'updates:get',
  updatesCheck: 'updates:check',
  updatesDownload: 'updates:download',
  updatesCancel: 'updates:cancel',
  updatesInstall: 'updates:install',
  updatesSkip: 'updates:skip',
  updatesOpenPage: 'updates:open-page',
  updatesState: 'updates:state'
} as const
