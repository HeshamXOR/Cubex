import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { nanoid } from 'nanoid'
import { AIGateway, createSubagentTool } from '@core/gateway'
import { DEFAULT_RETRY_POLICY } from '@core/types'
import type {
  AIMessage,
  AIRequest,
  AIStreamEvent,
  ExecutableTool,
  GatewayEvent,
  MessageContentPart,
  RoutingPolicy,
  RoutingTarget,
  ToolCall,
  ToolDefinition,
  ToolPermissionDecision,
  NormalizedAIError
} from '@core/types'
import { userMessage, assistantMessage, assistantTurn } from '@core/builders'
import { parseXmlToolCalls, mapXmlToolCall, stripCodeForToolParsing, type ParsedXmlToolCall } from '@core/tools/xmlToolCalls'
import type { ChatEvent, ChatStartRequest, PermissionAsk, PermissionDecision, PermissionMode, PermissionRule, PlanAsk, PlanDecision, QuestionAsk } from '@shared/ipc'
import { conversationRepo, usageRepo } from './db'
import { getSettings } from './config'
import { createFileTools, parseDiffMarker, parseDiffBody, parseFileActivities, fileMutationPaths } from './tools/fileTools'
import { afterEditDiagnoseHook } from './diagnostics/service'
import { sanitizeDiagnosticsSummary } from '@shared/diagnosticsSummary'
import { CheckpointStore } from './checkpoints'
import type { RestoreHost } from './restoreCoordinator'
import { createTodoTool } from './tools/todoTool'
import { createShellTool, isReadOnlyShellCommand } from './tools/shellTool'
import { createAskUserTool } from './tools/askUserTool'
import { createPlanTool, createReadPlanTool } from './tools/planTool'
import { createWebFetchTool, fetchHost, PREAPPROVED_FETCH_HOSTS } from './tools/webFetchTool'
import { createWebSearchTool } from './tools/webSearchTool'
import { loadSkills, skillsCatalog, createSkillTool } from './skills'
import { invokeSkill } from './skillInvocation'
import { SKILL_SOURCE_LABEL, skillTurnText } from '@shared/skillInvocation'
import { loadAgentProfiles } from './agents'
import { CONSULT_TOOL, DELEGATE_TOOL, cleanPeerIds, delegatePeers, enabledPeers, roleIsReadOnly, type AcpPeer, type ModelPeer, type PeerConfig } from '@shared/peers'
import { consultApprovalText, consultDisplay, consultPeerId, consultRisk, consultTitle, createConsultTool, type ModelAsk } from './peers/consultTool'
import { createDelegateTool, delegateApprovalText, delegateDisplay, delegateRisk, delegateRoleOf, delegateTitle, type DelegateTurn } from './peers/delegateTool'
import type { DelegateQuestion } from './peers/acp/delegatePolicy'
import { PEER_TIMEOUT_MS, type PeerRun } from './peers/peerRunner'
import { AcpSessions, type AcpRunOptions } from './peers/acp/sessions'
import { PeerTranscripts } from './peers/transcript'
import { runHooks, type HookPayload } from './hooks'
import { RepeatGuard } from './repeatGuard'
import { WorkingSetTracker } from './workingSet'
import { isContextOverflow } from '@core/errors/overflow'
import { createGoalTool } from './tools/goalTool'
import { evaluateGoal } from './goal/evaluator'
import { runCheckCommand } from './goal/checkRunner'
import { digestTurn } from './goal/digest'
import { normalizeGoalRequest, type GoalEvaluateRequest, type GoalVerdict } from '@shared/goal'
import { McpManager } from './mcp/McpManager'
import { enabledMcpSpecs } from './mcp/specs'
import type { ProviderManager } from './ProviderManager'
import { recordUsage } from './cost'
import { logger } from './logger'
import { dataDir } from './paths'
import { PlanStore, PlanReviews, planResolutionResult, validatePlanInput } from './plans'
import { buildHarnessSystemPrompt } from './systemPrompt'
import { estimateContextUsage, type ContextSystemSource } from './contextUsage'
import { ContextAnchorStore } from './contextAnchor'
import { formatSummaryMessage, selectContext } from './contextHistory'
import { CompactionCoordinator } from './compactionCoordinator'
import { BudgetGuard, type SpendSnapshot } from './budget'
import type { CompactionEvent, CompactionResult } from '@shared/ipc'
import type { HunkRevertResult, ReviewComment, ReviewFile, ReviewScope } from '@shared/ipc'
import { formatReviewComments } from '@shared/reviewComments'
import { normalizeUserAttachments } from './attachments'
import { escalatedOutputLimit, outputLimitFromError, resolveOutputLimit } from '@shared/outputLimit'
import { TurnLogStore } from './turnLog'
import { describeIdentity, modelIdentity } from './modelIdentity'
import {
  cutOffCallNote, cutOffReplyNotice, hasUnparsedCall, isUnparsedInput, repeatedCutOffNotice, unreadableArgumentsResult, withOutputLimit
} from './outputCutoff'
import { CommandOutputStore, type CommandOutputPage } from './commandOutput'
import { createReadCommandOutputTool } from './tools/readCommandOutputTool'
import { createGitTools } from './tools/gitTools'
import { ProcessManager } from './processManager'
import { resolveShell } from './shell/shellProvider'
import { createProcessTools } from './tools/processTools'
import { SessionChangeStore, type SessionFileChange, type SessionRevertResult } from './sessionChanges'
import { PermissionRuleStore, suggestRule, type RuleSuggestion } from './permissionRules'
import { MAX_PARALLEL_TOOLS, createLimiter, mayOverlap, notRunResult, toolFailureResult } from './parallelTools'

/**
 * Model requests per user turn. Coding tasks routinely need 20-40 tool rounds;
 * reaching the cap is reported to the user instead of ending silently.
 */
const MAX_TOOL_ITERATIONS = 50
/** How many times Stop hooks may send the agent back to work in one turn. After that the turn ends, whatever they say. */
const STOP_HOOK_MAX_CONTINUATIONS = 3
const STOP_HOOK_CAP_NOTICE = `\n\n_A Stop hook asked for more work ${STOP_HOOK_MAX_CONTINUATIONS} times, so Cubex ended the turn here. Check what the hook's command does when it runs again._`
const ITERATION_LIMIT_NOTICE = `\n\n_Cubex paused this turn at the ${MAX_TOOL_ITERATIONS}-request tool-iteration limit. Reply "continue" to keep going._`
/** Writes here can change how git, Cubex or other agents execute: never auto-approved. */
const PROTECTED_PATH = /(?:^|[\\/])(?:\.git|\.cubex|\.claude|\.agents|\.codex|\.vscode|\.husky)(?:[\\/]|$)/i
/** Tool calls recovered from model text (not native tool_use) carry this id prefix. */
const XML_CALL_PREFIX = 'xmlcall_'
/** The tool that hands a subtask to a subagent (see createSubagentTool). */
const SUBAGENT_TOOL = 'delegate_to_subagent'
const FILE_MUTATION_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit', 'apply_patch', 'remove_file'])

/** Max bytes of project instruction files to inject (Claude Code-style). */
const INSTRUCTIONS_BUDGET = 48 * 1024

/** One model of one provider, as the key of what is remembered about it. */
/**
 * Run the Stop hooks for a reply that ends the turn. A hook that blocks (exit code 2, or a printed block decision) asks
 * the agent to keep working, and its message becomes the next instruction. After STOP_HOOK_MAX_CONTINUATIONS requests
 * the turn ends anyway, so a hook that always asks cannot hold a turn open.
 */
async function askStopHooks(workspace: string | undefined, continuations: number):
  Promise<{ kind: 'end' } | { kind: 'capped' } | { kind: 'continue'; reason: string; message: string }> {
  const outcome = await runHooks(getSettings().hooks, { event: 'Stop', cwd: workspace, stop_hook_active: continuations > 0 }, workspace)
  if (!outcome.block) return { kind: 'end' }
  if (continuations >= STOP_HOOK_MAX_CONTINUATIONS) return { kind: 'capped' }
  const reason = (outcome.reason?.trim() || 'A Stop hook asked you to keep working.').slice(0, 2_000)
  return { kind: 'continue', reason, message: `A Stop hook asked you to keep working before you finish. Its message:\n\n${reason}` }
}

function outputCapKey(target: RoutingTarget): string {
  return `${target.providerId}\u0000${target.model}`
}

/** Object key order must not let an identical failed call evade the turn guard. */
function canonicalToolInput(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
  }) ?? 'null'
}

/** Match read recovery to a single file; file tools still enforce all access checks. */
function recoveryFilePath(workspace: string | undefined, input: ToolCall['input']): string | undefined {
  const path = (input as { path?: unknown } | null)?.path
  if (!workspace || typeof path !== 'string' || !path.trim()) return undefined
  let absolute = resolve(workspace, path)
  try { absolute = realpathSync.native(absolute) }
  catch { /* Missing or inaccessible paths retain their normalized spelling. */ }
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** Every file a failed mutation could be retried after reading: all the files of an apply_patch. */
function recoveryFilePaths(workspace: string | undefined, call: ToolCall): string[] {
  return fileMutationPaths(call.name, call.input).flatMap((path) => recoveryFilePath(workspace, { path }) ?? [])
}

/** What the row of a finished task shows when opened: the agent's report, or why there is none. */
function delegateDetail(report: unknown, text: string, failed: boolean): string {
  const said = typeof report === 'string' ? report.trim() : ''
  return said ? said.slice(0, 4000) : toolDisplayDetail(text, false, failed)
}

function toolDisplayDetail(text: string, hasOutput: boolean, failed: boolean): string {
  const detail = text.replace(/«diff[^»]*»/g, '')
    .replace(hasOutput ? /\n\nSaved output: [^\n]+/g : /$^/, '').trim()
  const limit = failed ? 4000 : hasOutput ? 1600 : 400
  if (detail.length <= limit) return detail
  return `${detail.slice(0, limit * .7)}\n… [preview shortened] …\n${detail.slice(-limit * .3)}`
}

/**
 * Load project instruction files from the workspace root — CLAUDE.md / AGENTS.md
 * (and .cubex/AGENTS.md) — the way Claude Code injects CLAUDE.md. Identical
 * CLAUDE.md/AGENTS.md are de-duplicated; total is capped to a byte budget.
 */
function loadProjectInstructions(workspace: string): string | undefined {
  const seen = new Set<string>()
  const blocks: string[] = []
  let budget = INSTRUCTIONS_BUDGET
  for (const rel of ['CLAUDE.md', 'AGENTS.md', join('.cubex', 'AGENTS.md')]) {
    const file = join(workspace, rel)
    try {
      if (!existsSync(file)) continue
      const raw = readFileSync(file, 'utf8').trim()
      if (!raw) continue
      const key = raw.slice(0, 512)
      if (seen.has(key)) continue // CLAUDE.md == AGENTS.md dedup
      seen.add(key)
      const text = raw.length > budget ? `${raw.slice(0, budget)}\n…(truncated)` : raw
      budget -= text.length
      blocks.push(`# ${rel}\n${text}`)
      if (budget <= 0) break
    } catch {
      /* unreadable — skip */
    }
  }
  if (!blocks.length) return undefined
  return `Project instructions from the workspace (treat as authoritative project context):\n\n${blocks.join('\n\n')}`
}

/**
 * Reduce a normalized error to a plain, safe wire object before it crosses IPC
 * to the renderer. Critically drops `cause`, which can carry an unredacted raw
 * provider response body/headers (IPC's structured clone ignores `toJSON`).
 */
function toWireError(error: NormalizedAIError): NormalizedAIError {
  const e = error as unknown as Record<string, unknown>
  return {
    provider: typeof e.provider === 'string' ? e.provider : 'gateway',
    category: e.category ?? 'UNKNOWN',
    message: typeof e.message === 'string' ? e.message : String(e.message ?? 'Unknown error'),
    classification: e.classification ?? 'unknown',
    retryable: e.retryable === true,
    ...(typeof e.statusCode === 'number' ? { statusCode: e.statusCode } : {}),
    ...(typeof e.retryAfterMs === 'number' ? { retryAfterMs: e.retryAfterMs } : {}),
    ...(typeof e.requestId === 'string' ? { requestId: e.requestId } : {})
  } as unknown as NormalizedAIError
}

/** The request settings a turn carries over to the next turn the main process starts for the person. */
type TurnSettings = Pick<ChatStartRequest, 'policy' | 'systemPrompt' | 'subagentEnabled' | 'fileToolsEnabled' | 'permissionMode' | 'longContext' | 'peers'>

/** What the renderer may change when it sends review comments: the model and the permission mode shown in its composer. */
export interface ReviewSendOverrides {
  target?: RoutingTarget
  permissionMode?: PermissionMode
  longContext?: boolean
  peers?: string[]
  systemPrompt?: string
}

/**
 * Bridges the renderer's chat requests to the core AIGateway. Runs a streaming
 * tool loop (model → tools → model), forwards normalized stream/gateway/tool
 * events over IPC, gates mutating tools behind a user permission round-trip, and
 * records usage/cost. Each active generation has an AbortController.
 */
export class ChatService {
  private readonly gateway: AIGateway
  private readonly active = new Map<string, AbortController>()
  private readonly eventStreams = new Map<string, { sequence: number; conversationId: string; parentMessageId?: string }>()
  private readonly pendingPermissions = new Map<string, (d: PermissionDecision) => void>()
  private readonly pendingQuestions = new Map<string, (answers: string[]) => void>()
  /** Set by `dispose`; the quit path runs it more than once. */
  private disposed = false
  /** Hosts the user approved for web_fetch, per stream (turn). */
  private readonly approvedFetchHosts = new Map<string, Set<string>>()
  /** Other agents the user approved the model talking to, per stream (turn): the first message asks, the rest of the talk does not. */
  private readonly approvedPeers = new Map<string, Set<string>>()
  /** The permission mode and the call of the delegated task being run, per stream (turn): the tool reads them when it asks. */
  private readonly delegateTurns = new Map<string, DelegateTurn>()
  /** The questions of a delegated task wait in line here, per stream (turn): only one is in front of the person at a time. */
  private readonly delegateAsks = new Map<string, Promise<unknown>>()
  /** What each task has said to each other agent, so a later message continues the talk. */
  private readonly peerTranscripts = new PeerTranscripts()
  /** The agents that speak ACP, kept running between messages: one session per task and agent. */
  private readonly acpSessions = new AcpSessions()
  /** The judging of a goal's last turn that is running for a task: a check command or a model's answer. */
  private readonly goalChecks = new Map<string, AbortController>()
  /** Tasks whose older turns are being summarized: the /compact command and the automatic trigger. */
  private readonly compaction: CompactionCoordinator
  /** The todo list, files and plan of each task, appended to every summary of it (see workingSet.ts). */
  private readonly workingSets = new WorkingSetTracker()
  /** Tasks that have had a turn in this run of the app: the first one fires the SessionStart hooks. */
  private readonly startedSessions = new Set<string>()
  /** `ai.budget`: what the turn, the task and the day have cost, checked before every model request. */
  private readonly budget = new BudgetGuard({
    settings: () => getSettings().ai?.budget,
    ledger: { spendSince: (since, conversationId) => usageRepo.spendSince(since, conversationId) }
  })
  private readonly plans = new PlanStore(join(dataDir(), 'plans'))
  /** What the model did in earlier turns (tool calls and their results), so a later turn can see it. */
  private readonly turnLog = new TurnLogStore(join(dataDir(), 'turn-log'), {
    onError: (error) => logger.warn(`Turn log: ${String(error)}`)
  })
  /** Tasks deleted while a turn was running: that turn must not write its record back. */
  private readonly forgotten = new Set<string>()
  private readonly planReviews = new PlanReviews(this.plans, (error) => logger.error(`Plan review: ${String(error)}`))
  private readonly mcp = new McpManager()
  /** The live MCP connections, for the Settings status line and for stopping servers that were turned off. */
  get mcpConnections(): McpManager { return this.mcp }
  private readonly checkpoints = new CheckpointStore()
  /** Last provider-reported input count per task; anchors the context meter and the compaction trigger. */
  private readonly contextAnchors = new ContextAnchorStore()
  private readonly commandOutputs = new CommandOutputStore(join(dataDir(), 'command-output'))
  /** Durable per-task originals for the review panel (checkpoints are per-turn and in-memory). */
  private readonly sessionChanges = new SessionChangeStore(join(dataDir(), 'session-changes'), {
    onError: (error) => logger.warn(`Session changes: ${String(error)}`),
    onChange: (conversationId, revision) => this.emitReview(conversationId, revision)
  })
  /** What each task's last turn ran with, so a turn this service starts for the person (review comments) matches it. */
  private readonly lastTurn = new Map<string, TurnSettings>()
  /** Answer limits a provider refused and named, per model, so later requests start from what it allows. */
  private readonly learnedOutputCaps = new Map<string, number>()
  /** "Always allow" rules, saved per project; only an ask this service raised can create one. */
  private readonly permissionRules = new PermissionRuleStore(join(dataDir(), 'permission-rules.json'), {
    onError: (error) => logger.warn(`Permission rules: ${String(error)}`)
  })
  public readonly processManager: ProcessManager

  constructor(
    private readonly providers: ProviderManager,
    private readonly emitWire: (event: ChatEvent) => void
  ) {
    this.processManager = new ProcessManager(this.commandOutputs)
    // A task outlives the turn that started it (a dev server keeps running), so its events must not ride
    // that turn's stream: `emit` drops anything from a stream that has been retired.
    this.processManager.subscribe((task, turnId) =>
      this.emitWire({ streamId: turnId ?? task.id, kind: 'task', task, conversationId: task.conversationId }))
    this.gateway = new AIGateway(this.providers.resolve)
    this.compaction = new CompactionCoordinator({
      repo: { get: (id) => conversationRepo.get(id), update: (id, patch) => conversationRepo.update(id, patch) },
      // The summary is a model request like any other: it is billed.
      send: async (request, routing, options) => {
        const response = await this.gateway.send(request, routing, options)
        this.captureUsage({ type: 'completed', response }, options?.conversationId)
        return response
      },
      modelInfo: (providerId, model) => this.providers.getModelInfo(providerId, model),
      isRunning: (id) => this.hasRunningTurn(id),
      budgetBlock: (id, target) => (this.isLocal(target) ? undefined : this.budget.blocker(id)),
      settings: () => getSettings(),
      loadHistory: (id) => this.loadHistory(id),
      workingSet: (id) => this.workingSets.render(id),
      warn: (message) => logger.warn(message)
    }, this.contextAnchors)
  }

  private emit(event: ChatEvent): void {
    const owner = this.eventStreams.get(event.streamId)
    if (!owner) return // Ignore late callbacks after the owning stream is retired.
    owner.sequence++
    this.emitWire({ ...event, ...owner })
  }

  /**
   * Start a turn. `beforeRun` is called once the turn is set up and before its first event, for a caller
   * that must tell the window about the stream (review comments) before anything arrives on it.
   */
  async start(req: ChatStartRequest, beforeRun?: () => void): Promise<{ streamId: string }> {
    const streamId = req.streamId ?? nanoid()
    if (typeof streamId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(streamId)) throw new Error('Invalid stream id.')
    if (this.active.has(streamId)) throw new Error('This chat stream is already running.')
    // Two loops on one conversation would race on its workspace and history.
    for (const [otherId, owner] of this.eventStreams) {
      if (owner.conversationId === req.conversationId && this.active.has(otherId)) {
        throw new Error('This task already has a running turn. Stop it before starting another.')
      }
    }
    // A compaction in flight is about to move this task's context boundary.
    if (this.compaction.isCompacting(req.conversationId)) throw new Error('This task is being compacted. Try again in a moment.')
    const controller = new AbortController()
    this.active.set(streamId, controller)
    this.eventStreams.set(streamId, { sequence: 0, conversationId: req.conversationId, parentMessageId: req.messageId })
    this.compaction.rememberPolicy(req.conversationId, req.policy)
    this.lastTurn.set(req.conversationId, {
      policy: req.policy, systemPrompt: req.systemPrompt, subagentEnabled: req.subagentEnabled,
      fileToolsEnabled: req.fileToolsEnabled, permissionMode: req.permissionMode, longContext: req.longContext, peers: req.peers
    })
    // How much one reply may write is settled here, so every request of the turn carries a number.
    const policy = this.withOutputLimits(req.policy)
    const autoOutputLimit = !((req.policy.primary.params?.maxOutputTokens ?? 0) > 0)

    try {
      const history = this.loadHistory(req.conversationId)
      // What the person kept or undid in the review panel since their last message, for the model to know once.
      const reviewNotes = this.sessionChanges.pendingReviewNotes(req.conversationId)
      const userMsg: AIMessage = {
        role: 'user',
        content: normalizeUserAttachments([
          { type: 'text', text: req.userText },
          ...(reviewNotes ? [{ type: 'text' as const, text: reviewNotes }] : []),
          ...(req.attachments ?? [])
        ])
      }
      const messages: AIMessage[] = [...history, userMsg]

      // The model is told who it is (what the picker shows), not given another name.
      const identity = modelIdentity(policy.primary.model, this.providers.getModelInfo(policy.primary.providerId, policy.primary.model))

      // Assemble the tool set for this turn.
      const tools = new Map<string, ExecutableTool>()
      const savedOutputs = this.commandOutputs.list(req.conversationId)
      if (savedOutputs.length) {
        const readOutput = createReadCommandOutputTool(this.commandOutputs, req.conversationId)
        tools.set(readOutput.definition.name, readOutput)
      }
      const savedPlans = this.plans.list(req.conversationId)
      if (savedPlans.length) {
        const readPlan = createReadPlanTool(this.plans, req.conversationId)
        tools.set(readPlan.definition.name, readPlan)
      }
      const planContext = savedPlans.length
        ? 'Saved plans at the start of this turn, newest first (up to 10). Later tool results supersede this catalog.\n' +
          savedPlans.slice(0, 10).map((plan) => JSON.stringify({ id: plan.id, title: plan.title, status: plan.status })).join('\n')
        : undefined
      // The task owns its working folder; switching the global project selector
      // must never redirect a running task's file tools or hooks.
      const workspace = conversationRepo.get(req.conversationId)?.workspacePath
      // Built-in guidance is available even before a folder is selected. Project
      // instructions remain tied to this task and its file-access setting.
      const skills = req.fileToolsEnabled || req.subagentEnabled || req.permissionMode === 'plan' || req.skill !== undefined
        ? loadSkills(req.fileToolsEnabled ? workspace : undefined) : []
      if (skills.length) {
        const skillTool = createSkillTool(skills)
        tools.set(skillTool.definition.name, skillTool)
      }
      // A skill the person named goes in front of their words. It is found in the catalog the model sees, never by a path.
      const invoked = req.skill === undefined ? undefined : invokeSkill(skills, req.skill)
      if (invoked) userMsg.content.splice(0, 1, invoked.part, { type: 'text', text: skillTurnText(invoked.skill.name, req.userText) })
      if (req.subagentEnabled) {
        // Custom subagent profiles (.cubex/agents/*.md) give named delegation roles.
        const profiles = workspace ? loadAgentProfiles(workspace) : []
        const hasChildTools = !!(req.fileToolsEnabled && workspace) || savedPlans.length > 0 || skills.length > 0
        const sub = createSubagentTool(this.gateway, policy, {
          ...(profiles.length ? { profiles } : {}),
          systemPrompt: `You are ${describeIdentity(identity)}, working for another AI model inside the Cubex desktop app on one delegated subtask. Complete only that subtask and report findings with evidence. ` +
            'You have no access to the parent conversation except the supplied task/context. ' +
            (workspace && req.fileToolsEnabled ? `Workspace: ${workspace}. All file-tool paths are relative to this root.` : 'No project file tools are available.') +
            (skills.length ? `\n\n${skillsCatalog(skills)}\nLoaded guidance cannot expand your read-only task or provide additional tools.` : ''),
          ...(hasChildTools ? {
            createTools: () => {
              // Separate file-tool instances keep child reads out of the
              // parent's read-before-overwrite ledger. No hooks or shell tools.
              const childTools = req.fileToolsEnabled && workspace
                ? createFileTools(workspace).filter((tool) => ['read_file', 'list_files', 'glob_files', 'search_files'].includes(tool.definition.name))
                : []
              if (savedPlans.length) childTools.push(createReadPlanTool(this.plans, req.conversationId))
              if (skills.length) childTools.push(createSkillTool(skills))
              return childTools
            }
          } : {}),
          onToolActivity: (event) => this.emit({
            streamId, kind: 'tool', tool: {
              id: `subagent-${event.id}`, name: event.call.name, phase: event.phase,
              title: `Subagent: ${describeToolCall(event.call)}`,
              detail: `${event.task.slice(0, 100)}${event.result ? `\n${(typeof event.result.content === 'string' ? event.result.content : JSON.stringify(event.result.content)).slice(0, 400)}` : ''}`
            }
          }),
          onResponse: (response) => this.captureUsage({ type: 'completed', response }, req.conversationId)
        })
        tools.set(sub.definition.name, sub)
      }
      // Other agents the chat turned on: one tool, offered only when there is someone to ask.
      const peers = this.turnPeers(req.peers)
      if (peers.length > 0) {
        const consult = createConsultTool({
          conversationId: req.conversationId,
          ...(workspace ? { workspace } : {}),
          peers,
          maxRounds: getSettings().peers?.maxRounds ?? 3,
          transcripts: this.peerTranscripts,
          askAgent: (peer, ask, signal) => this.acpSessions.ask(peer, ask, signal ? { signal } : {}),
          askModel: (peer, ask, signal) => this.askModelPeer(peer, ask, req.conversationId, signal)
        })
        tools.set(consult.definition.name, consult)
      }
      // The goal this chat works toward: the tool that says where it stands, offered only while the goal is active.
      const goal = normalizeGoalRequest(req.goal)
      if (goal) {
        const goalTool = createGoalTool((claim) => this.emit({ streamId, kind: 'goal', claim }))
        tools.set(goalTool.definition.name, goalTool)
      }
      // Read once per turn: the shell the model is told about is the one run_command uses, and a
      // changed setting applies from the next turn.
      const shellPreference = getSettings().shell?.preferred ?? 'auto'
      if (req.fileToolsEnabled && workspace) {
        const turnSeq = this.checkpoints.beginTurn(req.conversationId, req.messageId)
        for (const t of createFileTools(workspace, (p, before, existed, after) => {
          // Review tracking never throws, so it goes first: the edit stays reviewable even if the checkpoint fails.
          this.sessionChanges.record(req.conversationId, p, before, existed, after)
          this.checkpoints.record(req.conversationId, turnSeq, p, before, existed, after)
        }, afterEditDiagnoseHook(workspace, () => getSettings().diagnostics?.afterEdit === 'errors')))
          tools.set(t.definition.name, t)
        // A shell tool turns Cubex into a real coding agent (build/test/git). It
        // runs arbitrary commands, so it is gated hard: ask in default mode,
        // blocked in plan mode, auto only for read-only probes or in bypass.
        const shell = createShellTool(workspace, {
          outputStore: this.commandOutputs,
          conversationId: req.conversationId,
          // Stop on this turn ends the background tasks it starts, and only those (see `cancel`).
          turnId: streamId,
          processManager: this.processManager,
          preferredShell: shellPreference
        })
        tools.set(shell.definition.name, shell)
        const readOutput = createReadCommandOutputTool(this.commandOutputs, req.conversationId)
        tools.set(readOutput.definition.name, readOutput)
        for (const pt of createProcessTools({
          conversationId: req.conversationId,
          processManager: this.processManager
        })) {
          tools.set(pt.definition.name, pt)
        }
        // Structured git: five reads that never prompt, plus commit and branch behind the same
        // ask gate as run_command (so they are blocked in plan mode and never auto-approved by a rule).
        for (const t of createGitTools(workspace)) tools.set(t.definition.name, t)
        // Agents that may be handed whole tasks. They work in this project, so there has to be one, and what they change is
        // kept for Changes and Rewind the way the edits of the file tools are.
        const delegates = delegatePeers(peers)
        if (delegates.length > 0) {
          const slot: DelegateTurn = { mode: req.permissionMode ?? 'default', callId: '' }
          this.delegateTurns.set(streamId, slot)
          const delegate = createDelegateTool({
            conversationId: req.conversationId,
            workspace,
            agents: delegates,
            turn: slot,
            ask: (question, signal) => this.askDelegate(streamId, question, signal),
            progress: (activity) => this.emit({ streamId, kind: 'tool', tool: { id: slot.callId, name: DELEGATE_TOOL, phase: 'running', delegate: activity } }),
            recordChange: (path, before, existed) => {
              this.sessionChanges.record(req.conversationId, path, before, existed)
              this.checkpoints.record(req.conversationId, turnSeq, path, before, existed)
            },
            isProtected: (path) => PROTECTED_PATH.test(path.replace(/^\.[\\/]/, '')),
            isReadOnlyCommand: (command) => isReadOnlyShellCommand(command, workspace)
          })
          tools.set(delegate.definition.name, delegate)
        }
      }
      // Web fetch is available in any agentic posture (no workspace needed) so the
      // model can consult live docs. Read-only + SSRF-guarded → no prompt.
      if (req.fileToolsEnabled || req.subagentEnabled) {
        const web = createWebFetchTool()
        tools.set(web.definition.name, web)
        const websearch = createWebSearchTool()
        tools.set(websearch.definition.name, websearch)
      }
      // Once the model is in a tool-using posture (files and/or subagents), give
      // it a task checklist so multi-step work is trackable (surfaced live in the
      // UI, not a file mutation → no permission prompt).
      if (tools.size > 0) {
        const todo = createTodoTool((todos) => {
          this.workingSets.setTodos(req.conversationId, todos)
          this.emit({ streamId, kind: 'todos', todos })
        })
        tools.set(todo.definition.name, todo)
        const askUser = createAskUserTool((q, signal) => this.requestQuestion(streamId, q, signal))
        tools.set(askUser.definition.name, askUser)
      }
      // Plan mode gets an explicit hand-off tool so it has a clean endpoint (call
      // exit_plan_mode with the plan → pause for approval) instead of researching
      // forever. Special-cased in the loop so approving switches the turn's mode.
      if ((req.permissionMode ?? 'default') === 'plan') {
        const planTool = createPlanTool()
        tools.set(planTool.definition.name, planTool)
      }

      // External MCP servers — connect lazily (cached across turns), then offer
      // their tools as mcp__<server>__<tool>. Unreachable servers are skipped.
      const mcpSpecs = enabledMcpSpecs(getSettings().mcpServers)
      if (mcpSpecs.length) {
        const mcpTools = await this.mcp.getTools(mcpSpecs)
        for (const t of mcpTools) tools.set(t.definition.name, t)
      }

      // Build a fresh permission section after plan approval; never leave stale
      // read-only instructions in the implementation request.
      const projectInstructions = workspace ? loadProjectInstructions(workspace) : undefined
      const skillInstructions = skills.length ? skillsCatalog(skills) : undefined
      let systemSources: ContextSystemSource[] = []
      // The prompt describes the shell run_command will start, not whichever one `auto` would pick.
      const shellSyntaxNote = tools.has('run_command') ? resolveShell(shellPreference).syntaxNote : undefined
      const systemForMode = (nextMode: PermissionMode): string => buildHarnessSystemPrompt({
        model: identity,
        tools: [...tools.values()].map((tool) => tool.definition),
        mode: nextMode,
        workspace,
        platform: process.platform,
        ...(shellSyntaxNote ? { shellSyntaxNote } : {}),
        userInstructions: req.systemPrompt,
        projectInstructions,
        skillsCatalog: skillInstructions,
        planContext,
        ...(goal ? { goal } : {}),
        commandOutputContext: savedOutputs.length ? savedOutputs.slice(0, 10).map((output) => JSON.stringify({
          id: output.id, command: output.command.slice(0, 160), status: output.status, capturedBytes: output.capturedBytes
        })).join('\n') : undefined,
        onSections: (sections) => { systemSources = sections }
      })
      const mode: PermissionMode = req.permissionMode ?? 'default'
      const system = systemForMode(mode)

      const request: AIRequest = {
        model: policy.primary.model,
        messages,
        ...(system ? { system } : {}),
        ...(tools.size ? { tools: [...tools.values()].map((t) => t.definition) } : {}),
        stream: true
      }
      const headers = req.longContext ? { 'x-cubex-long-context': '1' } : undefined

      // The model has the review notes now, and an Undo from before this message no longer applies.
      try { this.sessionChanges.consumeReviewNotes(req.conversationId) }
      catch (error) { logger.warn(`Could not clear review notes: ${(error as Error).message}`) }
      beforeRun?.()
      // The thread shows the skill the person applied as a finished card, the way it shows one the model loaded.
      if (invoked) this.emit({ streamId, kind: 'tool', tool: {
        id: `skill-${streamId}`, name: 'skill', phase: 'done', title: `Skill ${invoked.skill.name}`,
        detail: toolDisplayDetail(`# Skill: ${invoked.skill.name}\nSource: ${SKILL_SOURCE_LABEL[invoked.skill.source]}\n\n${invoked.body}`, false, false)
      } })
      // UserPromptSubmit hooks run first thing in the loop: they can stop the turn or add context.
      void this.runLoop(streamId, req.conversationId, request, policy, tools, controller, mode, systemForMode, () => systemSources, workspace, headers, autoOutputLimit, req.userText)
      return { streamId }
    } catch (error) {
      controller.abort()
      this.active.delete(streamId)
      this.eventStreams.delete(streamId)
      throw error
    }
  }

  private loadHistory(conversationId: string): AIMessage[] {
    const conv = conversationRepo.get(conversationId)
    if (!conv) return []
    const out: AIMessage[] = []
    const context = selectContext(conv.messages, conv.contextStartMessageId, conv.contextSummary)
    // A stored answer is only its text. For a turn that used tools, the record of what the model did stands in
    // for it, so the model sees its own earlier tool calls and what they returned.
    const turns = this.turnLog.load(conversationId)
    let answering: string | undefined
    // A user-role message, so every provider accepts it at the head of the request.
    if (context.summary) out.push(userMessage(formatSummaryMessage(context.summary)))
    for (const m of context.messages) {
      if (m.role === 'user') {
        answering = m.id
        // Prefer stored content parts (text + image/file attachments) so images
        // stay visible to the model on later turns, not just the turn they were sent.
        if (m.contentJson) {
          try {
            const parts = JSON.parse(m.contentJson) as MessageContentPart[]
            if (Array.isArray(parts) && parts.length) {
              out.push({ role: 'user', content: normalizeUserAttachments(parts, { historical: true }) })
              continue
            }
          } catch {
            /* fall back to text */
          }
        }
        if (m.text) out.push(userMessage(m.text))
      } else if (m.role === 'assistant') {
        const recorded = answering ? turns.get(answering) : undefined
        answering = undefined
        if (recorded) out.push(...structuredClone(recorded))
        else if (m.text) out.push(assistantMessage(m.text))
      }
    }
    return out
  }

  /** How many turns are generating right now, in any task. Restarting Cubex would stop them. */
  get runningTurns(): number {
    return this.active.size
  }

  /** How many goals are being judged right now: a check command is running, or a model is reading the record of a turn. */
  get runningGoalChecks(): number {
    return this.goalChecks.size
  }

  /** True while any stream of this task is generating. */
  private hasRunningTurn(conversationId: string): boolean {
    for (const [streamId, owner] of this.eventStreams) {
      if (owner.conversationId === conversationId && this.active.has(streamId)) return true
    }
    return false
  }

  /**
   * Summarize a task's older turns instead of silently dropping them (the
   * /compact command). Refused while a turn runs; a failed summary changes nothing.
   */
  async compactConversation(conversationId: string): Promise<CompactionResult> {
    let cwd: string | undefined
    try { cwd = this.sessionWorkspace(conversationId) } catch { /* an unknown task is reported by the compaction itself */ }
    let started = false
    const result = await this.compaction.compact(conversationId, () => {
      started = true
      this.fireHooks({ event: 'PreCompact', session_id: conversationId, trigger: 'manual', cwd }, cwd)
    })
    if (started) {
      this.fireHooks({
        event: 'PostCompact', session_id: conversationId, trigger: 'manual', cwd,
        ...(result.ok ? { summary: result.summary.slice(0, 2_000) } : {})
      }, cwd)
    }
    return result
  }

  /** A local model adds nothing to the bill, so a spending cap never applies to it. */
  private isLocal(target: RoutingTarget): boolean {
    return this.providers.getModelInfo(target.providerId, target.model)?.location === 'local'
  }

  /**
   * The same routing with every model's answer limit settled: the person's number, or the automatic size,
   * never above what that model (or a refusal it once sent) says it can write. A local runtime keeps its own
   * default unless the person set a number, since it sizes replies to the window it was loaded with.
   */
  private withOutputLimits(policy: RoutingPolicy): RoutingPolicy {
    const settle = (target: RoutingTarget): RoutingTarget => {
      const info = this.providers.getModelInfo(target.providerId, target.model)
      const requested = target.params?.maxOutputTokens
      if (info?.location === 'local' && !(typeof requested === 'number' && requested > 0)) {
        const { maxOutputTokens: _auto, ...params } = target.params ?? {}
        return { ...target, params }
      }
      const known = this.learnedOutputCaps.get(outputCapKey(target)) ?? info?.maxOutputTokens
      return { ...target, params: { ...target.params, maxOutputTokens: resolveOutputLimit(requested, known) } }
    }
    return { ...policy, primary: settle(policy.primary), fallbacks: policy.fallbacks.map(settle) }
  }

  /**
   * The gateway's events for one request, with a second try when the provider refuses the answer limit and says
   * which one it allows (an endpoint that serves models of different sizes under one address, say). The limit is
   * remembered for that model, so the next request starts from it. Only a refusal that arrives before anything
   * was generated is retried; the error is otherwise passed on unchanged.
   */
  private async *modelEvents(
    request: AIRequest,
    routing: { read: () => RoutingPolicy; write: (policy: RoutingPolicy) => void },
    options: Parameters<AIGateway['stream']>[2]
  ): AsyncGenerator<AIStreamEvent> {
    for (let attempt = 0; ; attempt++) {
      let allowed: number | undefined
      for await (const event of this.gateway.stream(request, routing.read(), options)) {
        if (event.type === 'error' && attempt === 0) {
          const target = routing.read().primary
          const current = target.params?.maxOutputTokens
          const limit = outputLimitFromError(event.error.message)
          if (limit !== undefined && current !== undefined && limit < current) {
            allowed = limit
            this.learnedOutputCaps.set(outputCapKey(target), limit)
            break
          }
        }
        yield event
      }
      if (allowed === undefined) return
      routing.write(withOutputLimit(routing.read(), allowed))
    }
  }

  /**
   * The check before every model request of a turn. Warnings go to the thread once per crossing. When a cap
   * set to stop is reached, the reason is added to the reply, so it stays in the transcript, and the caller
   * ends the turn without sending the request.
   */
  private budgetStopsTurn(streamId: string, conversationId: string, policy: RoutingPolicy): boolean {
    if (this.isLocal(policy.primary)) return false
    try {
      const verdict = this.budget.check(conversationId)
      for (const notice of verdict.notices) this.emit({ streamId, kind: 'budget', budget: notice })
      if (!verdict.stop) return false
      const reasons = verdict.notices.filter((notice) => notice.stopped).map((notice) => `_${notice.message}_`)
      this.emit({ streamId, kind: 'stream', event: { type: 'text_delta', text: `\n\n${reasons.join('\n\n')}` } })
      logger.info('Chat turn stopped by the budget', { status: 'stopped' })
      return true
    } catch (error) {
      // The ledger could not be read: carry on rather than end the turn over bookkeeping.
      logger.warn(`Budget check failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /** What the day, a task and its running turn have cost, for the usage view. */
  budgetSnapshot(conversationId?: string): SpendSnapshot {
    return this.budget.snapshot(conversationId)
  }

  /** Model → tool → model loop with streaming, over the gateway. */
  private async runLoop(
    streamId: string,
    conversationId: string,
    baseRequest: AIRequest,
    policy: RoutingPolicy,
    tools: Map<string, ExecutableTool>,
    controller: AbortController,
    mode: PermissionMode,
    systemForMode: (mode: PermissionMode) => string,
    getSystemSources: () => readonly ContextSystemSource[],
    workspace?: string,
    headers?: Record<string, string>,
    autoOutputLimit = false,
    userText = ''
  ): Promise<void> {
    let currentRequest = baseRequest
    let currentTarget = policy.primary
    const publishContext = (target: RoutingTarget, measuredInputTokens?: number): number => {
      const model = this.providers.getModelInfo(target.providerId, target.model)
      // Models marked with the gated 1M beta use their ordinary 200K window
      // until the user enables that header for this request.
      const contextWindow = model?.contextWindow && model.longContextBeta && headers?.['x-cubex-long-context'] !== '1'
        ? Math.min(model.contextWindow, 200_000)
        : model?.contextWindow
      const effectiveRequest: AIRequest = {
        ...currentRequest,
        model: target.model,
        ...(target.params ? { params: { ...currentRequest.params, ...target.params } } : {})
      }
      const context = estimateContextUsage(effectiveRequest, {
        provider: target.providerId,
        contextWindow,
        measuredInputTokens,
        ...(this.contextAnchors.get(conversationId) ? { anchor: this.contextAnchors.get(conversationId)! } : {}),
        systemSources: getSystemSources()
      })
      this.emit({ streamId, kind: 'context', context })
      return context.estimatedTokens
    }
    const onGateway = (event: GatewayEvent): void => {
      if (event.type === 'attempt_start') {
        currentTarget = event.target
        // The gateway can choose a different model/output limit on a fallback.
        // Rebuild from that attempt, and clear any older provider measurement.
        publishContext(event.target)
      }
      this.emit({ streamId, kind: 'gateway', event })
    }
    const started = Date.now()
    const toolDefs: ToolDefinition[] | undefined = tools.size
      ? [...tools.values()].map((t) => t.definition)
      : undefined
    const messages = [...baseRequest.messages]
    let finalProvider = policy.primary.providerId
    let finalModel = policy.primary.model

    // Tracks whether the UI has received a terminal event (completed/error). If
    // the loop ends without one, we synthesize a completed so the assistant
    // message never hangs in a streaming state.
    let uiTerminated = false
    let lastResponse: import('@core/types').AIResponse | undefined
    // Guards against the model looping on the exact same tool call forever.
    const callCounts = new Map<string, number>()
    const failedCalls = new Map<string, { revision: number; detail: string; filePath?: string; filePaths?: string[] }>()
    let workspaceRevision = 0
    /** Successful file edits so far in this turn. Repeat checks compare calls made between the same edits. */
    let fileEdits = 0
    // Soft cap on how many times one read-only research tool may run in a turn,
    // so a model that keeps re-searching (varying the query) can't spin for
    // minutes. Only applied to research tools — edits/reads legitimately repeat.
    const nameCounts = new Map<string, number>()
    let requestIteration = 0
    // Stored-history messages at the head of the request: automatic compaction swaps exactly these.
    let historyLength = baseRequest.messages.length - 1
    let autoCompactAttempted = false
    /** The request that just failed with a context overflow is being retried once. */
    let overflowRetrying = false
    const repeatGuard = new RepeatGuard()
    /** Notes for the result of a call that repeated an identical one, by call id. */
    const repeatNotes = new Map<string, string>()
    let iterationLimitReached = false
    /** Replies that stopped at the output limit in the middle of a tool call, this turn. */
    let outputCuts = 0
    /** How many times a Stop hook has sent the agent back to work this turn. */
    let stopContinuations = 0
    /** What a Stop hook asked for, from the moment a reply ends until the loop adds it to the turn. */
    let stopFeedback: string | undefined
    /** The Stop hooks ran when the last reply ended, so the end of the turn does not run them a second time. */
    let stopHooksRan = false
    // What the model did this turn, in order, for the record the next turns read (see turnLog.ts).
    const turn: AIMessage[] = []
    let closing: AIMessage | undefined
    const addToTurn = (...added: AIMessage[]): void => {
      messages.push(...added)
      turn.push(...added)
    }
    /** Why the turn ended early, for the person: added to the end of the reply, like the iteration limit. */
    let stoppedNotice = ''
    const RESEARCH_TOOLS = new Set(['web_search', 'web_fetch', 'search_files'])
    const RESEARCH_CAP = 6
    // Fold a finished call into the repeat/failure bookkeeping and build the tool_result the model receives.
    const recordToolResult = (call: ToolCall, sig: string, result: { content: unknown; isError?: boolean }): MessageContentPart => {
      const rawText = typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
      const repeatNote = repeatNotes.get(call.id)
      const text = repeatNote ? `${rawText}\n\n${repeatNote}` : rawText
      if (!result.isError) this.trackWorkingSet(conversationId, call)
      if (result.isError) failedCalls.set(sig, {
        revision: workspaceRevision,
        detail: text.slice(0, 4000),
        ...(FILE_MUTATION_TOOLS.has(call.name) ? { filePath: recoveryFilePath(workspace, call.input) } : {}),
        ...(call.name === 'apply_patch' ? { filePaths: recoveryFilePaths(workspace, call) } : {})
      })
      else if (call.name === 'read_file') {
        // A fresh read can satisfy a mutation's missing/stale observation
        // without changing the workspace. Recheck only that file's failed
        // mutations; unrelated reads must never unlock failed shell calls.
        const filePath = recoveryFilePath(workspace, call.input)
        if (filePath) for (const [failedSig, failure] of failedCalls) {
          if (failure.filePath === filePath || failure.filePaths?.includes(filePath)) failedCalls.delete(failedSig)
        }
      } else if (FILE_MUTATION_TOOLS.has(call.name) ||
        (call.name === 'run_command' && !isReadOnlyShellCommand(String((call.input as { command?: string } | null)?.command ?? ''), workspace))) workspaceRevision++
      if (!result.isError && FILE_MUTATION_TOOLS.has(call.name)) fileEdits++
      return {
        type: 'tool_result',
        toolUseId: call.id,
        content: [{ type: 'text', text }],
        ...(result.isError ? { isError: true } : {})
      }
    }

    this.budget.beginTurn(conversationId)
    try {
      // The first turn of a task in this run of the app.
      if (!this.startedSessions.has(conversationId)) {
        this.startedSessions.add(conversationId)
        this.fireHooks({ event: 'SessionStart', session_id: conversationId, cwd: workspace }, workspace)
      }
      // UserPromptSubmit: a hook can stop the turn before any request, or add context the model alone sees.
      const prompt = await runHooks(getSettings().hooks, { event: 'UserPromptSubmit', prompt: userText.slice(0, 2_000), cwd: workspace }, workspace)
      if (prompt.block) {
        const reason = (prompt.reason?.trim() || 'A UserPromptSubmit hook stopped this message.').slice(0, 2_000)
        stopHooksRan = true
        uiTerminated = true
        this.emit({ streamId, kind: 'stream', event: { type: 'error', error: {
          provider: 'hook', category: 'INVALID_REQUEST', message: `Stopped by a UserPromptSubmit hook: ${reason}`,
          classification: 'permanent', retryable: false
        } as unknown as NormalizedAIError } })
        return
      }
      if (prompt.additionalContext) {
        const last = messages[messages.length - 1]
        if (last?.role === 'user') messages[messages.length - 1] = {
          ...last,
          content: [...last.content, { type: 'text', text: `Context added by a UserPromptSubmit hook:\n${prompt.additionalContext}` }]
        }
      }
      for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
        // Before anything that costs money: a budget cap set to stop ends the turn here, and says why.
        if (this.budgetStopsTurn(streamId, conversationId, policy)) break
        const retrying = overflowRetrying
        overflowRetrying = false
        /** Progress of a summary, reported to the thread and to the compaction hooks. */
        const compactionProgress = (trigger: 'auto' | 'overflow') => (compaction: CompactionEvent): void => {
          this.emit({ streamId, kind: 'compaction', compaction })
          if (compaction.step !== 'summarize') return
          if (compaction.phase === 'started') this.fireHooks({ event: 'PreCompact', session_id: conversationId, trigger, cwd: workspace }, workspace)
          else this.fireHooks({
            event: 'PostCompact', session_id: conversationId, trigger, cwd: workspace,
            ...(compaction.phase === 'completed' && compaction.summary ? { summary: compaction.summary.slice(0, 2_000) } : {})
          }, workspace)
        }
        const requestNow = (): AIRequest => ({ ...baseRequest, messages, ...(toolDefs ? { tools: toolDefs } : {}) })
        // Old tool output becomes stubs first, which can make a summary unnecessary.
        const pruned = this.compaction.prune(conversationId, requestNow(), policy, headers)
        if (pruned) {
          messages.splice(0, messages.length, ...pruned.messages)
          this.emit({ streamId, kind: 'compaction', compaction: pruned.event })
        }
        // Once per turn, summarize older turns if this request is nearly full; this turn's own messages stay.
        if (!autoCompactAttempted) {
          const auto = await this.compaction.auto(conversationId, requestNow(), policy, headers, controller.signal, compactionProgress('auto'))
          autoCompactAttempted = auto.attempted
          if (auto.compacted) {
            this.emit({ streamId, kind: 'compacted', summary: auto.compacted.summary, boundaryMessageId: auto.compacted.boundaryMessageId })
            if (auto.compacted.history) {
              messages.splice(0, historyLength, ...auto.compacted.history)
              historyLength = auto.compacted.history.length
            }
          }
          // The summary was a paid request, so the request after it may no longer fit the budget.
          if (auto.attempted && this.budgetStopsTurn(streamId, conversationId, policy)) break
        }
        if (controller.signal.aborted) break
        this.emit({ streamId, kind: 'iteration', iteration: ++requestIteration })
        const req: AIRequest = { ...baseRequest, messages, ...(toolDefs ? { tools: toolDefs } : {}) }
        currentRequest = req
        currentTarget = policy.primary
        publishContext(currentTarget)
        let completed: import('@core/types').AIResponse | undefined
        let streamedText = ''
        /** Added to the end of a reply that stopped at the output limit, so it does not look finished. */
        let cutNotice = ''
        const willContinue = (calls: number, includesPlan = false): boolean => calls > 0 && toolDefs !== undefined &&
          (iter < MAX_TOOL_ITERATIONS - 1 || (mode === 'plan' && includesPlan))

        /** The provider said the request does not fit: held back until the loop has tried to shrink it. */
        let overflow: Extract<AIStreamEvent, { type: 'error' }> | undefined
        for await (const event of this.modelEvents(req, { read: () => policy, write: (next) => { policy = next } }, {
          signal: controller.signal,
          onEvent: onGateway,
          ...(headers ? { headers } : {})
        })) {
          this.captureUsage(event, conversationId)
          // Once per request, and only before any of the reply reached the thread.
          if (event.type === 'error' && !retrying && !streamedText && !controller.signal.aborted && isContextOverflow(event.error)) {
            overflow = event
            continue
          }
          if (event.type === 'text_delta') streamedText += event.text
          if (event.type === 'completed') {
            // Anchor on what the provider says this exact request cost, paired
            // with our estimate of it, before the reply is appended to `messages`.
            const estimatedAtReport = publishContext(
              { ...currentTarget, providerId: event.response.provider, model: event.response.model },
              event.response.usage?.inputTokens
            )
            this.contextAnchors.recordUsage(conversationId, event.response.usage, estimatedAtReport)
            completed = event.response
            lastResponse = event.response
            // Some adapters finish with text that was never streamed. Preserve
            // it before the subsequent tool event, including intermediate turns.
            if (event.response.text.startsWith(streamedText) && event.response.text.length > streamedText.length) {
              this.emit({ streamId, kind: 'stream', event: { type: 'text_delta', text: event.response.text.slice(streamedText.length) } })
            }
            finalProvider = event.response.provider
            finalModel = event.response.model
            // Count native tool_use blocks OR, if none, tool calls the model
            // emitted as <invoke> XML in its text (some proxied models do this).
            const nativeCount = event.response.toolCalls.length
            const xmlCalls = !nativeCount && toolDefs ? parseXmlToolCalls(stripCodeForToolParsing(event.response.text)) : []
            const effectiveCount = nativeCount || xmlCalls.length
            const includesPlan = event.response.toolCalls.some((call) => call.name === 'exit_plan_mode') ||
              xmlCalls.some((call) => this.mapXmlCall(call, tools).name === 'exit_plan_mode')
            // Suppress the intermediate `completed` only when we'll loop again
            // for tools; otherwise it flows through and ends the UI stream.
            if (willContinue(effectiveCount, includesPlan)) continue
            // The model still wants tools but the budget is spent: hold the
            // terminal event and report the limit below instead of ending silently.
            if (effectiveCount > 0 && toolDefs) { iterationLimitReached = true; continue }
            // A reply that ends the turn: Stop hooks may ask for more work. They run before the terminal event goes
            // out, so the thread does not show the turn as finished while it carries on.
            if (effectiveCount === 0 && event.response.stopReason !== 'length' && !controller.signal.aborted) {
              stopHooksRan = true
              const answer = await askStopHooks(workspace, stopContinuations)
              if (!controller.signal.aborted) {
                if (answer.kind === 'continue') {
                  stopContinuations++
                  stopFeedback = answer.message
                  this.emit({ streamId, kind: 'tool', tool: { id: `stop-hook-${stopContinuations}`, name: 'stop_hook', phase: 'done', title: 'Stop hook asked for more work', detail: answer.reason.slice(0, 400) } })
                  continue
                }
                if (answer.kind === 'capped') {
                  cutNotice = STOP_HOOK_CAP_NOTICE
                  this.emit({ streamId, kind: 'stream', event: { type: 'text_delta', text: cutNotice } })
                }
              }
            }
            // A reply with no tool call that stopped at the limit ends mid-way: say so, where it ends.
            if (event.response.stopReason === 'length' && effectiveCount === 0) {
              const spentThinking = !event.response.text.trim() && (event.response.usage?.reasoningTokens ?? 0) > 0
              cutNotice = cutOffReplyNotice(currentTarget.params?.maxOutputTokens ?? event.response.usage?.outputTokens ?? 0, spentThinking)
              this.emit({ streamId, kind: 'stream', event: { type: 'text_delta', text: cutNotice } })
            }
          }
          if (event.type === 'completed' || event.type === 'error') uiTerminated = true
          // Strip the raw `cause` (which can carry an unredacted provider
          // response body) before it crosses IPC to the renderer.
          this.emit({
            streamId, kind: 'stream',
            event: event.type === 'error' ? { type: 'error', error: isContextOverflow(event.error) ? { ...toWireError(event.error), category: 'CONTEXT_LENGTH' } as NormalizedAIError : toWireError(event.error) }
              : event.type === 'completed' && cutNotice ? { ...event, response: { ...event.response, text: `${event.response.text}${cutNotice}` } }
                : event
          })
        }

        if (overflow) {
          // Stub old tool output, then summarize older turns, and send the same request once more.
          const recovered = await this.compaction.recoverFromOverflow(conversationId, requestNow(), policy, headers, controller.signal, compactionProgress('overflow'))
          if (recovered.changed && !controller.signal.aborted) {
            messages.splice(0, messages.length, ...recovered.messages)
            if (recovered.compacted) {
              this.emit({ streamId, kind: 'compacted', summary: recovered.compacted.summary, boundaryMessageId: recovered.compacted.boundaryMessageId })
              if (recovered.compacted.history) {
                messages.splice(0, historyLength, ...recovered.compacted.history)
                historyLength = recovered.compacted.history.length
              }
            }
            autoCompactAttempted = true
            overflowRetrying = true
            iter--
            continue
          }
          // Nothing could be shrunk, or the summary failed: the turn ends with the context-length error.
          uiTerminated = true
          this.emit({ streamId, kind: 'stream', event: { type: 'error', error: { ...toWireError(overflow.error), category: 'CONTEXT_LENGTH' } as NormalizedAIError } })
          break
        }

        let calls = completed?.toolCalls ?? []
        // Fallback: recover tool calls the model emitted as <invoke> XML in its
        // text (instead of native tool_use blocks) and map foreign tool names
        // (fs_read, execute_bash, …) onto the tools this harness actually has.
        if (calls.length === 0 && completed && toolDefs) {
          const xml = parseXmlToolCalls(stripCodeForToolParsing(completed.text))
          if (xml.length) calls = xml.map((c) => this.mapXmlCall(c, tools))
        }
        // A reply that stopped at the output limit inside a tool call holds half a call, and running it would
        // write a truncated file. Nothing runs: the model is told what happened, with more room to answer in
        // when the limit was the automatic one. A turn that keeps being cut ends, and says why.
        if (completed?.stopReason === 'length' && toolDefs && hasUnparsedCall(calls)) {
          outputCuts++
          const used = currentTarget.params?.maxOutputTokens ?? policy.primary.params?.maxOutputTokens ?? completed.usage?.outputTokens ?? 0
          const modelMax = this.providers.getModelInfo(currentTarget.providerId, currentTarget.model)?.maxOutputTokens
          const raisedTo = autoOutputLimit && used > 0 ? escalatedOutputLimit(used, modelMax) : undefined
          if (outputCuts > 2 || (outputCuts > 1 && !raisedTo)) {
            stoppedNotice = repeatedCutOffNotice(used, modelMax)
            break
          }
          if (raisedTo) policy = withOutputLimit(policy, raisedTo)
          addToTurn(...(completed.text.trim() ? [assistantMessage(completed.text)] : []), userMessage(cutOffCallNote(used, raisedTo)))
          continue
        }
        // A Stop hook asked for more work: the reply so far and the hook's message join the turn, and the model answers again.
        if (stopFeedback !== undefined && completed) {
          const feedback = stopFeedback
          stopFeedback = undefined
          addToTurn(...(completed.text.trim() ? [assistantMessage(completed.text)] : []), userMessage(feedback))
          continue
        }
        // Break unless we're going to loop for tools. `willContinue` already
        // gates on calls>0, tools present, and iterations remaining — so at the
        // iteration cap we stop here instead of executing tools whose results
        // could never be sent back to the model (and whose side effects, e.g.
        // write_file, would run after the UI already ended the turn).
        if (!completed || !willContinue(calls.length, calls.some((call) => call.name === 'exit_plan_mode'))) {
          // The reply that ends the turn was never added to `messages`: it closes the record of the turn.
          if (completed?.text.trim()) closing = assistantMessage(completed.text)
          break
        }

        // Record the assistant tool_use turn, then run each tool. Blocks are
        // replayed in the order the model produced them: signed thinking is only
        // valid where it was generated, and models that think between tool calls
        // reject a turn rebuilt as all thinking first (400).
        addToTurn(assistantTurn(completed, calls))
        const resultParts: AIMessage['content'] = []
        // Calls in this batch were authored under the old mode. Approval takes
        // effect on the next model request, after it receives the review result.
        const toolBatchMode = mode
        let repeatStop: string | undefined
        // Consecutive auto-allowed read-only calls run side by side (at most MAX_PARALLEL_TOOLS at once).
        // Each reserves its slot in resultParts so results keep the model's call order, and any other
        // call waits for them first, so mutations, prompts and special tools stay strictly sequential.
        const limit = createLimiter(MAX_PARALLEL_TOOLS)
        const overlapped: Array<Promise<void>> = []
        const overlappedSigs = new Set<string>()
        const settleOverlapped = async (): Promise<void> => {
          await Promise.all(overlapped.splice(0)) // each entry handles its own failure
          overlappedSigs.clear()
        }
        for (const call of calls) {
          if (controller.signal.aborted) break
          // exit_plan_mode: pause and present the plan for approval. On approval
          // we switch THIS turn's permission mode so the model implements right
          // away (no second "go ahead" round-trip that would restart research).
          if (call.name === 'exit_plan_mode') {
            await settleOverlapped()
            try {
              if (mode !== 'plan' || !tools.has('exit_plan_mode')) {
                throw new Error('exit_plan_mode is only available during plan mode. Continue with the current task and permissions.')
              }
              const input = validatePlanInput(call.input)
              this.emit({ streamId, kind: 'tool', tool: { id: call.id, name: call.name, phase: 'running', title: 'Review plan', detail: 'Awaiting your approval' } })
              const resolution = await this.planReviews.request(conversationId, input, controller.signal,
                (ask) => this.emit({ streamId, kind: 'plan', ask }))
              const result = planResolutionResult(resolution)
              mode = result.mode
              if (resolution.decision !== 'reject') {
                baseRequest = { ...baseRequest, system: systemForMode(mode) }
                this.emit({ streamId, kind: 'mode', mode })
              }
              // Rejection is a completed review decision, not a tool failure.
              // The model still receives isError below and remains in Plan mode.
              this.emit({ streamId, kind: 'tool', tool: {
                id: call.id, name: call.name, phase: resolution.cancelled ? 'error' : 'done',
                ...(resolution.cancelled ? { interrupted: true } : {}),
                title: resolution.cancelled ? 'Plan review cancelled' : resolution.decision === 'reject' ? 'Plan needs revision' : 'Plan approved',
                detail: result.isError ? 'No implementation approved' : `Approved in ${mode} mode`
              } })
              resultParts.push({
                type: 'tool_result',
                toolUseId: call.id,
                content: [{ type: 'text', text: result.text }],
                ...(result.isError ? { isError: true } : {})
              })
              // A human review starts fresh work (implementation or revision),
              // even when research consumed the previous iteration budget.
              if (!resolution.cancelled) {
                iter = -1
                callCounts.clear()
                failedCalls.clear()
                nameCounts.clear()
                repeatGuard.reset()
                if (resolution.decision !== 'reject') this.workingSets.setPlan(conversationId, input.plan, input.title)
              }
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error)
              this.emit({ streamId, kind: 'tool', tool: { id: call.id, name: call.name, phase: 'error', title: 'Plan unavailable', detail } })
              resultParts.push({ type: 'tool_result', toolUseId: call.id, content: [{ type: 'text', text: detail }], isError: true })
            }
            continue
          }
          // Arguments that were not valid JSON never reach a tool: it would fail on a missing field and the
          // model would not learn why. (A reply cut off by the output limit is handled before this loop.)
          if (isUnparsedInput(call.input)) {
            const detail = 'The arguments were not valid JSON, so the call was not run.'
            this.emit({ streamId, kind: 'tool', tool: { id: call.id, name: call.name, phase: 'error', title: describeToolCall(call), detail } })
            resultParts.push({ type: 'tool_result', toolUseId: call.id, isError: true, content: [{ type: 'text', text: unreadableArgumentsResult(call.name) }] })
            continue
          }
          // Repeat-tool guard: if the model fires the identical call 3+ times,
          // stop executing it and nudge it to change approach or finish.
          const sig = createHash('sha256').update(`${call.name}:${canonicalToolInput(call.input)}`).digest('hex')
          // A call that cannot overlap waits for the reads before it, and an identical call never overlaps
          // its twin: the guards below must see how every earlier call ended.
          const overlap = this.canOverlap(streamId, tools, call)
          if (!overlap || overlappedSigs.has(sig)) await settleOverlapped()
          // Repeat guard: the third identical call in a row gets a note; five of the last ten end the turn.
          const repeat = repeatGuard.record(call.name, call.input, fileEdits)
          if (repeat.stop) {
            repeatStop = repeat.stop
            await settleOverlapped()
            for (const skipped of calls.slice(calls.indexOf(call))) resultParts.push(notRunResult(skipped.id))
            break
          }
          if (repeat.note) repeatNotes.set(call.id, repeat.note)
          const priorFailure = failedCalls.get(sig)
          if (priorFailure?.revision === workspaceRevision) {
            const detail = 'This exact call already failed. Correct the input or resolve the cause before trying again.'
            this.emit({ streamId, kind: 'tool', tool: { id: call.id, name: call.name, phase: 'error', title: describeToolCall(call), detail } })
            resultParts.push({ type: 'tool_result', toolUseId: call.id, isError: true, content: [{ type: 'text', text: `${detail}\nPrevious failure:\n${priorFailure.detail}` }] })
            continue
          }
          // Counted per state of the files: running the tests again after an edit is not a repeat.
          const countKey = `${sig}:${fileEdits}`
          const count = (callCounts.get(countKey) ?? 0) + 1
          callCounts.set(countKey, count)
          if (count > 3) {
            this.emit({ streamId, kind: 'tool', tool: { id: call.id, name: call.name, phase: 'error', title: describeToolCall(call), detail: 'Repeated identical call — skipped' } })
            resultParts.push({
              type: 'tool_result',
              toolUseId: call.id,
              content: [{ type: 'text', text: `You have already made this exact "${call.name}" call ${count - 1} times. Do not repeat it without new evidence — use the results you already have or report what remains unresolved.` }],
              isError: true
            })
            continue
          }
          // Research soft-cap: too many web/file searches in one turn → make it
          // commit to an answer instead of spinning on slightly-varied queries.
          const nameCount = (nameCounts.get(call.name) ?? 0) + 1
          nameCounts.set(call.name, nameCount)
          if (RESEARCH_TOOLS.has(call.name) && nameCount > RESEARCH_CAP) {
            this.emit({ streamId, kind: 'tool', tool: { id: call.id, name: call.name, phase: 'error', title: describeToolCall(call), detail: 'Too many searches this turn — skipped' } })
            resultParts.push({
              type: 'tool_result',
              toolUseId: call.id,
              content: [{ type: 'text', text: `You have already used "${call.name}" ${nameCount - 1} times this turn. Stop searching and proceed with what you have: give your answer or implement the plan using the information already gathered.` }],
              isError: true
            })
            continue
          }
          if (overlap) {
            // Reserve this call's place in the results, then run it beside the other read-only calls.
            const slot = resultParts.length
            resultParts.push(notRunResult(call.id))
            overlappedSigs.add(sig)
            overlapped.push(limit(async () => {
              if (controller.signal.aborted) return // keeps the "cancelled before it ran" placeholder
              try {
                resultParts[slot] = recordToolResult(call, sig, await this.runTool(streamId, tools, call, controller, toolBatchMode, workspace, conversationId))
              } catch (error) {
                // One failing read must not sink its neighbours: report it as that call's own error.
                const detail = error instanceof Error ? error.message : String(error)
                this.emit({ streamId, kind: 'tool', tool: { id: call.id, name: call.name, phase: 'error', title: describeToolCall(call), detail } })
                resultParts[slot] = toolFailureResult(call.id, error)
              }
            }))
            continue
          }
          // Everything else runs alone: the reads before it have already settled.
          const result = await this.runTool(streamId, tools, call, controller, toolBatchMode, workspace, conversationId)
          resultParts.push(recordToolResult(call, sig, result))
        }
        await settleOverlapped()
        addToTurn({ role: 'tool', content: resultParts })
        if (repeatStop) {
          stoppedNotice = `\n\n${repeatStop}`
          break
        }
      }

      // Safety net: guarantee the UI always gets a terminal event.
      if (!uiTerminated) {
        if (controller.signal.aborted) {
          this.emit({ streamId, kind: 'stream', event: { type: 'stop', stopReason: 'cancelled' } })
        } else if (iterationLimitReached) {
          this.emit({ streamId, kind: 'stream', event: { type: 'text_delta', text: ITERATION_LIMIT_NOTICE } })
        } else if (stoppedNotice) {
          this.emit({ streamId, kind: 'stream', event: { type: 'text_delta', text: stoppedNotice } })
        }
        // Never reuse a prior iteration's toolCalls here: a stale response with
        // tool_use blocks would make the UI render tool cards for a turn that
        // actually cancelled or ran dry. Keep any streamed text, drop the calls.
        this.emit({
          streamId,
          kind: 'stream',
          event: {
            type: 'completed',
            response: {
              id: lastResponse?.id ?? streamId,
              provider: finalProvider,
              model: finalModel,
              content: [],
              text: `${lastResponse?.text ?? ''}${iterationLimitReached && !controller.signal.aborted ? ITERATION_LIMIT_NOTICE : ''}${stoppedNotice && !iterationLimitReached && !controller.signal.aborted ? stoppedNotice : ''}`,
              toolCalls: [],
              stopReason: controller.signal.aborted ? 'cancelled' : 'stop',
              createdAt: started
            } as import('@core/types').AIResponse
          }
        })
      }

      logger.info('Chat turn completed', {
        provider: finalProvider,
        model: finalModel,
        durationMs: Date.now() - started,
        status: 'ok'
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`Chat stream error: ${message}`, { provider: finalProvider, model: finalModel })
      this.emit({
        streamId,
        kind: 'stream',
        event: {
          type: 'error',
          error:
            err instanceof Error && 'category' in err
              ? toWireError(err as unknown as NormalizedAIError)
              : ({ provider: finalProvider, category: 'UNKNOWN', message, classification: 'unknown', retryable: false } as never)
        } as AIStreamEvent
      })
    } finally {
      // However the turn ended, what the model did in it goes on record: the next turn starts from it.
      const answered = this.eventStreams.get(streamId)?.parentMessageId
      if (answered && !this.forgotten.has(conversationId)) {
        try { this.turnLog.save(conversationId, answered, [...turn, ...(closing ? [closing] : [])]) }
        catch (error) { logger.warn(`Could not record the turn: ${error instanceof Error ? error.message : String(error)}`) }
      }
      this.active.delete(streamId)
      this.eventStreams.delete(streamId)
      this.approvedFetchHosts.delete(streamId)
      this.approvedPeers.delete(streamId)
      this.delegateTurns.delete(streamId)
      this.delegateAsks.delete(streamId)
      this.budget.endTurn(conversationId)
      // The turn is over, however it ended. A reply that ended it normally already ran the Stop hooks, which could
      // ask for more work; any other end (a stop, an error, a limit) only tells them.
      if (!stopHooksRan) void runHooks(getSettings().hooks, { event: 'Stop', cwd: workspace, stop_hook_active: stopContinuations > 0 }, workspace)
    }
  }

  /** Map a text-emitted `<invoke>` call onto a real registered tool. */
  private mapXmlCall(parsed: ParsedXmlToolCall, tools: Map<string, ExecutableTool>): ToolCall {
    const mapped = mapXmlToolCall(parsed, new Set(tools.keys()))
    return { id: `${XML_CALL_PREFIX}${nanoid()}`, name: mapped.name, input: mapped.input as ToolCall['input'] }
  }

  /** A web_fetch to a host that is neither pre-approved nor already approved earlier in this turn stops for the user. */
  private fetchNeedsApproval(streamId: string, call: ToolCall): boolean {
    const host = call.name === 'web_fetch' ? fetchHost(call.input) : undefined
    return !!host && !PREAPPROVED_FETCH_HOSTS.includes(host) && !this.approvedFetchHosts.get(streamId)?.has(host)
  }

  /**
   * A message to another agent leaves for a program or a service, so the first one to each agent in a turn stops for the
   * person, with the whole message in front of them. They are not asked again for the rest of that talk in the same turn.
   * A call to an agent that is not offered in this turn sends nothing, so it is not asked about either.
   */
  private consultNeedsApproval(streamId: string, tools: Map<string, ExecutableTool>, call: ToolCall): boolean {
    if (call.name !== CONSULT_TOOL) return false
    const id = consultPeerId(call.input)
    const schema = tools.get(CONSULT_TOOL)?.definition.inputSchema as { properties?: { agent?: { enum?: unknown } } } | undefined
    const offered = schema?.properties?.agent?.enum
    return id !== undefined && Array.isArray(offered) && offered.includes(id) && !this.approvedPeers.get(streamId)?.has(id)
  }

  private approvePeer(streamId: string, call: ToolCall): void {
    const id = consultPeerId(call.input)
    if (!id) return
    const approved = this.approvedPeers.get(streamId) ?? new Set<string>()
    approved.add(id)
    this.approvedPeers.set(streamId, approved)
  }

  /**
   * The agents a turn may ask: the ones the chat turned on that exist and are on in settings. Programs are not offered in
   * local-only mode, since nearly all of them send the message to a cloud service; a model follows the rule for providers.
   */
  private turnPeers(requested: readonly string[] | undefined): PeerConfig[] {
    const settings = getSettings()
    return enabledPeers(settings.peers, cleanPeerIds(requested)).filter((peer) => peer.kind === 'model' || !settings.privacy.localOnly)
  }

  /**
   * One question to a model that is another agent in a talk: a request of its own with no tools and no view of the
   * project, billed and counted like any other request. A failure is a result, so the model can say so to the person.
   */
  async askModelPeer(peer: ModelPeer, ask: ModelAsk, conversationId: string | undefined, signal?: AbortSignal): Promise<PeerRun> {
    const started = Date.now()
    const failed = (error: string, hint?: string): PeerRun => ({ ok: false, reply: '', error, ...(hint ? { hint } : {}), durationMs: Date.now() - started })
    const target: RoutingTarget = { providerId: peer.providerId, model: peer.model }
    if (conversationId && !this.isLocal(target)) {
      const blocked = this.budget.blocker(conversationId)
      if (blocked) return failed(blocked)
    }
    const messages: AIMessage[] = [
      ...ask.history.flatMap((entry) => [userMessage(entry.message), assistantMessage(entry.reply)]),
      userMessage(ask.message)
    ]
    const controller = new AbortController()
    const onAbort = (): void => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('The model did not answer in time.')), PEER_TIMEOUT_MS)
    try {
      const response = await this.gateway.send({ model: peer.model, system: ask.system, messages }, this.withOutputLimits(this.policyFor(target)), { signal: controller.signal })
      this.captureUsage({ type: 'completed', response }, conversationId)
      const text = response.text.trim()
      return text ? { ok: true, reply: text, durationMs: Date.now() - started } : failed(`${peer.name} returned no text.`)
    } catch (error) {
      if (signal?.aborted) return failed('Cancelled.')
      if (controller.signal.aborted) return failed(`${peer.name} did not answer in time.`)
      return failed(error instanceof Error ? error.message : String(error), 'Check the provider in Settings, then try again.')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /** One message to an agent that speaks ACP, in a session that is not kept: the Settings page's test. */
  testAcpPeer(peer: AcpPeer, message: string, options: AcpRunOptions): Promise<PeerRun> {
    return this.acpSessions.test(peer, message, options)
  }

  /** Stop the agents of one kind that are kept running between messages, in every task: what they hold in memory, such as a sign-in, is going. */
  endAgentSessions(preset: AcpPeer['preset']): void {
    this.acpSessions.endPreset(preset)
  }

  /**
   * Judge the turn that just ended against the task's goal: run its check command, or have a model read the record of
   * the turn (see goal/evaluator.ts). It never rejects: a turn that could not be judged is a verdict of its own, so the
   * window can pause the goal and say why. A new request for a task replaces the one still running.
   */
  async evaluateGoal(request: GoalEvaluateRequest): Promise<GoalVerdict> {
    const { conversationId } = request
    this.cancelGoalCheck(conversationId)
    const controller = new AbortController()
    this.goalChecks.set(conversationId, controller)
    try {
      return await evaluateGoal(request, {
        workspace: this.sessionWorkspace(conversationId),
        runCheck: (command, cwd, signal) => runCheckCommand(command, { cwd, shell: getSettings().shell?.preferred ?? 'auto', ...(signal ? { signal } : {}) }),
        ask: (system, prompt, signal) => this.askForGoal(conversationId, system, prompt, signal),
        digest: () => {
          const turns = [...this.turnLog.load(conversationId).values()]
          return digestTurn(turns[turns.length - 1] ?? [])
        },
        overBudget: () => this.budget.blocker(conversationId)
      }, controller.signal)
    } catch (error) {
      return { kind: 'error', reason: error instanceof Error ? error.message : String(error) }
    } finally {
      if (this.goalChecks.get(conversationId) === controller) this.goalChecks.delete(conversationId)
    }
  }

  /** Stop judging a task's goal: the person paused or cleared it. */
  cancelGoalCheck(conversationId: string): void {
    this.goalChecks.get(conversationId)?.abort()
    this.goalChecks.delete(conversationId)
  }

  /** One question to the model the task is using, with no tools and no effort setting. It counts in the usage like any request. */
  private async askForGoal(conversationId: string, system: string, prompt: string, signal?: AbortSignal): Promise<string> {
    const policy = this.lastTurn.get(conversationId)?.policy ?? this.storedPolicy(conversationId)
    if (!policy) throw new Error('Choose a model for this task first.')
    // A few words are needed, not a long chain of thought, so the effort the task was using is left out.
    const { reasoningEffort: _effort, ...params } = policy.primary.params ?? {}
    const target: RoutingTarget = { ...policy.primary, params: { ...params, maxOutputTokens: 1_500 } }
    const response = await this.gateway.send({ model: target.model, system, messages: [userMessage(prompt)] }, this.withOutputLimits(this.policyFor(target)), { ...(signal ? { signal } : {}) })
    this.captureUsage({ type: 'completed', response }, conversationId)
    return response.text
  }

  /** Whether this call may run beside the read-only calls around it: never one that could prompt, mutate or is special. */
  private canOverlap(streamId: string, tools: Map<string, ExecutableTool>, call: ToolCall): boolean {
    return mayOverlap(call.name, tools.get(call.name)?.defaultPermission, this.fetchNeedsApproval(streamId, call))
  }

  /** Execute one tool call with permission gating + activity events. */
  private async runTool(
    streamId: string,
    tools: Map<string, ExecutableTool>,
    call: ToolCall,
    controller: AbortController,
    mode: PermissionMode,
    workspace?: string,
    conversationId?: string,
    /** The PreToolUse hooks already ran and replaced the input: the call goes through the gate again, without them. */
    hooksRan = false
  ): Promise<{ content: unknown; isError?: boolean }> {
    const tool = tools.get(call.name)
    const title = describeToolCall(call)
    this.emit({ streamId, kind: 'tool', tool: { id: call.id, name: call.name, phase: 'running', title } })

    if (!tool) {
      this.emit({ streamId, kind: 'tool', tool: { id: call.id, name: call.name, phase: 'error', title, detail: 'Unknown tool' } })
      return { content: `Tool "${call.name}" is not available.`, isError: true }
    }

    // Classify the call: edits (write/edit_file) vs. exec (run_command). A
    // clearly read-only shell probe confined to the workspace isn't a mutation.
    const isEdit = call.name === 'write_file' || call.name === 'edit_file' || call.name === 'multi_edit' || call.name === 'apply_patch'
    const isFileMutation = FILE_MUTATION_TOOLS.has(call.name)
    const command =
      call.name === 'run_command' ? String((call.input as { command?: string } | null)?.command ?? '') : ''
    const readOnlyExec = call.name === 'run_command' && isReadOnlyShellCommand(command, workspace)
    // apply_patch names its files inside the patch text: every one of them is checked, not just a `path` argument.
    const protectedTarget = isFileMutation && fileMutationPaths(call.name, call.input).some((target) => PROTECTED_PATH.test(target.replace(/^\.[\\/]/, '')))
    const fromText = call.id.startsWith(XML_CALL_PREFIX)
    const host = call.name === 'web_fetch' ? fetchHost(call.input) : undefined
    const fetchNeedsApproval = this.fetchNeedsApproval(streamId, call)
    const consultNeedsApproval = this.consultNeedsApproval(streamId, tools, call)
    // A task that only reads (research, review) changes nothing, so plan mode lets it through, after the person has been asked.
    const readOnlyDelegation = call.name === DELEGATE_TOOL && roleIsReadOnly(delegateRoleOf(call.input))
    const mutating = tool.defaultPermission === 'ask' && !readOnlyExec && !readOnlyDelegation

    // Plan mode: reads/searches/read-only probes are fine, but nothing may mutate.
    if (mode === 'plan' && mutating) {
      this.emit({ streamId, kind: 'tool', tool: { id: call.id, name: call.name, phase: 'error', title, detail: 'Blocked in plan mode' } })
      return {
        content: `Plan mode is active — "${call.name}" is disabled. Do not modify anything; present a numbered plan for the user to approve instead.`,
        isError: true
      }
    }

    // Hard policy deny stands in every mode (even bypass).
    if (tool.defaultPermission === 'deny') {
      this.emit({ streamId, kind: 'tool', tool: { id: call.id, name: call.name, phase: 'error', title, detail: 'Denied by policy' } })
      return { content: `Tool "${call.name}" is denied.`, isError: true }
    }

    // Ask gate. Auto-approve when: bypass (everything), acceptEdits (edits outside
    // protected paths), or a confined read-only probe. Calls the harness recovered
    // from free text are never auto-approved: quoted examples are not intent.
    const askable = (tool.defaultPermission === 'ask' && !readOnlyExec) || fetchNeedsApproval || consultNeedsApproval
    if (askable) {
      const auto = !fromText && !(protectedTarget && mode !== 'bypass') &&
        (mode === 'bypass' || (isEdit && mode === 'acceptEdits'))
      if (!auto) {
        // Every applicable reason is shown; one must not mask another.
        const hostRisk = host && fetchNeedsApproval ? `Network request to ${host}. Data in the URL leaves this machine.` : undefined
        const risks = [
          protectedTarget && 'Protected path: changes here can alter how git, Cubex or other tools execute.',
          fromText && 'This call was parsed from model text, not a native tool call.',
          hostRisk,
          consultNeedsApproval && consultRisk(call.input, getSettings().peers?.list ?? [], workspace),
          call.name === DELEGATE_TOOL && delegateRisk(call.input, getSettings().peers?.list ?? [], workspace)
        ].filter((risk): risk is string => typeof risk === 'string')
        // A saved "Always allow" rule approves silently, but never a call that carries risks. The
        // outbound-host notice is the thing a host rule approves, so it alone does not block one.
        const ruleRisks = risks.filter((risk) => risk !== hostRisk)
        const ruled = ruleRisks.length === 0 && !!workspace && !!this.permissionRules.find(workspace, call)
        if (!ruled) {
          const rule = suggestRule(call, { workspace, mode, risks: ruleRisks })
          const decision = await this.requestPermission(streamId, call, title, controller, { risks, rule, workspace })
          if (decision.decision !== 'allow') {
            this.emit({ streamId, kind: 'tool', tool: { id: call.id, name: call.name, phase: 'error', title, detail: 'Denied by user' } })
            return { content: `Permission denied for "${call.name}".`, isError: true }
          }
        }
        if (host && !ruled) {
          const approved = this.approvedFetchHosts.get(streamId) ?? new Set<string>()
          approved.add(host)
          this.approvedFetchHosts.set(streamId, approved)
        }
        if (consultNeedsApproval) this.approvePeer(streamId, call)
      }
    }

    // PreToolUse hooks may veto the call (guardrails, e.g. block writes to a path).
    const hookSettings = getSettings()
    const hookCwd = workspace
    const pre = hooksRan ? { block: false } : await runHooks(
      hookSettings.hooks,
      { event: 'PreToolUse', tool_name: call.name, tool_input: call.input, cwd: hookCwd },
      hookCwd
    )
    if (pre.block) {
      const reason = pre.reason || 'blocked by a PreToolUse hook'
      this.emit({ streamId, kind: 'tool', tool: { id: call.id, name: call.name, phase: 'error', title, detail: `Blocked by hook: ${reason}` } })
      return { content: `Blocked by a project hook: ${reason}`, isError: true }
    }
    // A hook replaced the input. The tool does not run with what was approved: the new call goes through the
    // permission gate and the tool's own validation like any other, and its card shows the input that ran.
    if ('updatedInput' in pre && pre.updatedInput) {
      return this.runTool(streamId, tools, { ...call, input: pre.updatedInput as ToolCall['input'] }, controller, mode, workspace, conversationId, true)
    }

    try {
      // The delegated task reads the permission mode now, and shows its progress on this call's row.
      if (call.name === DELEGATE_TOOL) {
        const slot = this.delegateTurns.get(streamId)
        if (slot) { slot.mode = mode; slot.callId = call.id }
      }
      const result = await tool.execute(call.input, {
        ...(controller.signal ? { signal: controller.signal } : {}),
        requestPermission: async () => ({ decision: 'allow' })
      })
      const text = typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
      const diff = parseDiffMarker(text)
      const diffBody = parseDiffBody(text)
      // Multi-file calls (apply_patch) carry per-file activity as harness metadata, never in the model-visible text.
      const files = result.isError ? undefined : parseFileActivities(result.metadata)
      // New compiler errors an edit introduced, attached by the file tools as metadata.
      const diagnostics = result.isError ? undefined : sanitizeDiagnosticsSummary(result.metadata?.diagnostics)
      // A finished consultation shows who answered and what they said, not the wrapper the model gets.
      const consulted = call.name === CONSULT_TOOL && !result.isError ? consultDisplay(result.metadata) : undefined
      // A finished task shows who had it, what it did and which files it changed, with the agent's report as the detail.
      const delegated = call.name === DELEGATE_TOOL ? delegateDisplay(result.metadata) : undefined
      const outputId = result.metadata?.commandOutputId
      let output: ReturnType<CommandOutputStore['get']> = null
      if (call.name === 'run_command' && conversationId && typeof outputId === 'string') {
        try { output = this.commandOutputs.get(conversationId, outputId) }
        catch (error) { logger.warn(`Could not load saved command output: ${String(error)}`) }
      }
      this.emit({
        streamId,
        kind: 'tool',
        tool: {
          id: call.id,
          name: call.name,
          phase: result.isError ? 'error' : 'done',
          title,
          detail: consulted ? consulted.reply.slice(0, 4000)
            : delegated ? delegateDetail(result.metadata?.delegateReport, text, !!result.isError)
            : toolDisplayDetail(text, !!output, !!result.isError),
          ...(consulted ? { peer: consulted.peer } : {}),
          ...(delegated ? { delegate: delegated } : {}),
          ...(diff ? { added: diff.added, removed: diff.removed } : {}),
          ...(diffBody ? { diff: diffBody } : {}),
          ...(files ? { files } : {}),
          ...(diagnostics ? { diagnostics } : {}),
          ...(output ? { outputId: output.id, outputConversationId: conversationId } : {})
        }
      })
      // PostToolUse hooks (fire-and-forget) — e.g. auto-format after an edit.
      void runHooks(
        hookSettings.hooks,
        { event: 'PostToolUse', tool_name: call.name, tool_input: call.input, tool_result: text.slice(0, 2000), cwd: hookCwd },
        hookCwd
      )
      if (call.name === SUBAGENT_TOOL) {
        this.fireHooks({ event: 'SubagentStop', tool_name: call.name, tool_input: call.input, tool_result: text.slice(0, 2000), cwd: hookCwd }, hookCwd)
      }
      return { content: text.replace(/«diff[^»]*»/g, '').trim(), ...(result.isError ? { isError: true } : {}) }
    } catch (e) {
      const detail = (e as Error).message
      this.emit({ streamId, kind: 'tool', tool: { id: call.id, name: call.name, phase: 'error', title, detail } })
      return { content: `Tool error: ${detail}`, isError: true }
    }
  }

  private requestPermission(
    streamId: string,
    call: ToolCall,
    title: string,
    controller: AbortController,
    extra: { risks?: string[]; rule?: RuleSuggestion; workspace?: string } = {}
  ): Promise<ToolPermissionDecision> {
    const id = nanoid()
    const ask: PermissionAsk = {
      id,
      toolName: call.name,
      title,
      detail: permissionDetail(call),
      ...(extra.risks?.length ? { risks: extra.risks } : {}),
      ...(extra.rule ? { rule: extra.rule } : {})
    }
    return new Promise<ToolPermissionDecision>((resolvePromise) => {
      const onAbort = (): void => {
        this.pendingPermissions.delete(id)
        resolvePromise({ decision: 'deny', reason: 'cancelled' })
      }
      if (controller.signal.aborted) return onAbort()
      controller.signal.addEventListener('abort', onAbort, { once: true })
      this.pendingPermissions.set(id, (decision) => {
        controller.signal.removeEventListener('abort', onAbort)
        // `always` allows this call and saves the rule this service suggested (never one the renderer supplied).
        if (decision === 'always') this.saveRule(extra.workspace, extra.rule)
        resolvePromise(decision === 'deny' ? { decision } : { decision: 'allow', ...(decision === 'always' ? { remember: true } : {}) })
      })
      this.notifyWaiting(streamId, 'permission', `Cubex is waiting for you to approve ${title}.`, extra.workspace)
      this.emit({ streamId, kind: 'permission', ask })
    })
  }

  /** Persist an ask's suggested rule for its project. A failed save must not fail the call being approved. */
  private saveRule(workspace: string | undefined, rule: RuleSuggestion | undefined): void {
    if (!workspace || !rule) return
    try { this.permissionRules.add(workspace, rule) }
    catch (error) { logger.warn(`Could not save permission rule: ${(error as Error).message}`) }
  }

  /**
   * What an agent working on a delegated task asks to do, put to the person. The questions of one turn go one at a time,
   * because the window shows one, and an agent may ask several at once. Resolves to whether they allowed it; a stop, or a
   * turn that ended, is a no. There is never an "always": nothing here is saved.
   */
  private askDelegate(streamId: string, question: DelegateQuestion, signal?: AbortSignal): Promise<boolean> {
    const ask = (): Promise<boolean> => this.askDelegateOnce(streamId, question, signal)
    const previous = this.delegateAsks.get(streamId) ?? Promise.resolve()
    const mine = previous.then(ask, ask)
    this.delegateAsks.set(streamId, mine.catch(() => undefined))
    return mine
  }

  private askDelegateOnce(streamId: string, question: DelegateQuestion, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false)
    const id = nanoid()
    const { agent, action, target, command, title, detail, risks } = question
    const ask: PermissionAsk = {
      id,
      toolName: DELEGATE_TOOL,
      title,
      ...(detail ? { detail } : {}),
      ...(risks.length > 0 ? { risks } : {}),
      delegate: { agent, action, ...(target ? { target } : {}), ...(command ? { command } : {}) }
    }
    return new Promise<boolean>((resolvePromise) => {
      const onAbort = (): void => {
        this.pendingPermissions.delete(id)
        resolvePromise(false)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pendingPermissions.set(id, (decision) => {
        signal?.removeEventListener('abort', onAbort)
        resolvePromise(decision !== 'deny')
      })
      this.notifyWaiting(streamId, 'permission', `A delegated agent is waiting for you: ${title}.`)
      this.emit({ streamId, kind: 'permission', ask })
    })
  }

  resolvePermission(id: string, decision: PermissionDecision): void {
    const resolver = this.pendingPermissions.get(id)
    if (resolver) {
      this.pendingPermissions.delete(id)
      resolver(decision)
    }
  }

  /** Saved "Always allow" rules, optionally those of one project. */
  listPermissionRules(workspace?: string): PermissionRule[] {
    return this.permissionRules.list(workspace)
  }

  removePermissionRule(id: string): void {
    this.permissionRules.remove(id)
  }

  /** Restore workspace files to their state before a given user message's turn. */
  async rewindFiles(conversationId: string, messageId: string): Promise<{ restored: string[] }> {
    const result = await this.checkpoints.rewind(conversationId, messageId)
    // Rewound files hold Cubex-written content again; any back at their original drop out of review.
    await this.sessionChanges.syncRestored(conversationId, result.restored)
    return result
  }

  /** The stores a restore to an earlier message works on. They are private here, so the restore handler (ipcModules/restore.ts) gets them through this. */
  restoreHost(): RestoreHost {
    return {
      checkpoints: this.checkpoints,
      lockedReason: (conversationId) => this.hasRunningTurn(conversationId) ? 'Stop the running turn before restoring an earlier point.'
        : this.compaction.isCompacting(conversationId) ? 'Wait for the summary to finish, then restore.' : undefined,
      syncRestoredFiles: (conversationId, paths) => this.sessionChanges.syncRestored(conversationId, paths),
      trackWrite: (conversationId, path, before, existed, after) => this.sessionChanges.record(conversationId, path, before, existed, after),
      forgetReviewTurns: (conversationId, fromMessageId) => this.sessionChanges.forgetTurnsSince(conversationId, fromMessageId),
      plans: this.plans
    }
  }

  /** Net file changes this task made, against each file's pre-task state (review panel). */
  async getSessionChanges(conversationId: string): Promise<SessionFileChange[]> {
    return this.sessionChanges.list(conversationId, this.sessionWorkspace(conversationId))
  }

  /** Restore files to their pre-task state; every changed file when no paths are given. */
  async revertSessionChanges(conversationId: string, paths?: string[]): Promise<SessionRevertResult> {
    const workspace = this.sessionWorkspace(conversationId)
    for (const [streamId, owner] of this.eventStreams) {
      if (owner.conversationId === conversationId && this.active.has(streamId)) throw new Error('Stop the running turn before undoing its changes.')
    }
    const { result, files } = await this.sessionChanges.revert(conversationId, workspace, paths)
    // Restored files no longer hold what the rewind snapshots expect.
    this.checkpoints.forget(conversationId, files)
    return result
  }

  /** The hunks of what this task changed, per file, for the review panel. A task without a folder has nothing to review. */
  async getReview(conversationId: string, scope: ReviewScope): Promise<ReviewFile[]> {
    const workspace = this.sessionWorkspace(conversationId)
    return workspace ? this.sessionChanges.review(conversationId, workspace, scope) : []
  }

  /** Revert hunks of one file in the bytes it has now. Refused while a turn could be writing the file. */
  async revertHunks(conversationId: string, req: { path: string; hunkIds: string[]; expectHeadHash: string }): Promise<HunkRevertResult> {
    const workspace = this.idleWorkspace(conversationId)
    const result = await this.sessionChanges.revertHunks(conversationId, workspace, req)
    // The file no longer holds what the rewind snapshots expect, as after a whole-file undo.
    if (result.applied.length) this.checkpoints.forget(conversationId, [resolve(workspace, req.path)])
    return result
  }

  /** Keep hunks. Each item counts only while the file still has the bytes the person looked at. */
  async markReviewed(conversationId: string, items: Array<{ path: string; hunkIds: string[]; headHash: string }>): Promise<void> {
    const workspace = this.sessionWorkspace(conversationId)
    if (workspace) await this.sessionChanges.markReviewed(conversationId, workspace, items)
  }

  /** Undo a revert, of hunks or of whole files, while the files still hold what it wrote. */
  async undoRevert(conversationId: string, revertId: string): Promise<{ restored: string[] }> {
    const workspace = this.idleWorkspace(conversationId)
    const result = await this.sessionChanges.undoRevert(conversationId, workspace, revertId)
    this.checkpoints.forget(conversationId, result.restored.map((path) => resolve(workspace, path)))
    return result
  }

  /**
   * Send queued review comments as one user message and start a turn for it. The turn runs with the
   * settings of the task's last turn, except what `overrides` changes. The window hears of the message
   * (`userMessage`) before the turn's first event, and stores it with the transcript when the turn
   * settles, as it does a typed message: stored earlier, a compaction in the turn would read it twice.
   */
  async sendReviewComments(
    conversationId: string,
    comments: ReviewComment[],
    options: { streamId?: string; overrides?: ReviewSendOverrides } = {}
  ): Promise<{ messageId: string; streamId: string; text: string }> {
    const workspace = this.sessionWorkspace(conversationId)
    if (!workspace) throw new Error('This task has no workspace folder, so it has no changes to comment on.')
    if (this.hasRunningTurn(conversationId)) throw new Error('This task already has a running turn. Stop it before sending comments.')
    const settings = this.reviewTurnSettings(conversationId, options.overrides)
    const files = await this.sessionChanges.review(conversationId, workspace, { kind: 'session' })
    const text = formatReviewComments(comments.map((comment) => ({
      comment,
      hunk: files.find((file) => file.path === comment.path)?.hunks.find((hunk) => hunk.id === comment.hunkId)
    })))
    const messageId = nanoid()
    const streamId = options.streamId ?? nanoid()
    await this.start({ ...settings, streamId, conversationId, messageId, userText: text }, () => this.emit({ streamId, kind: 'userMessage', messageId, text }))
    return { messageId, streamId, text }
  }

  /** What a turn started for review comments runs with: the last turn's settings, or the task's own model when there was none yet. */
  private reviewTurnSettings(conversationId: string, overrides: ReviewSendOverrides = {}): TurnSettings {
    const last = this.lastTurn.get(conversationId)
    const policy = overrides.target ? this.policyFor(overrides.target) : last?.policy ?? this.storedPolicy(conversationId)
    if (!policy) throw new Error('Choose a model for this task before sending comments.')
    return {
      policy,
      // Comments ask for edits, which plan mode refuses: a task whose last turn only planned continues in the default mode.
      permissionMode: overrides.permissionMode ?? (last?.permissionMode === 'plan' ? 'default' : last?.permissionMode ?? 'default'),
      fileToolsEnabled: last?.fileToolsEnabled ?? true,
      subagentEnabled: last?.subagentEnabled ?? true,
      longContext: overrides.longContext ?? last?.longContext,
      peers: overrides.peers ?? last?.peers,
      systemPrompt: overrides.systemPrompt ?? last?.systemPrompt
    }
  }

  /** A routing policy for one model, with the retry and timeout settings the app is configured with. */
  private policyFor(target: RoutingTarget): RoutingPolicy {
    const ai = getSettings().ai
    return { primary: target, fallbacks: [], fallbackEnabled: ai?.fallbackEnabled ?? false, retry: ai?.retry ?? DEFAULT_RETRY_POLICY, timeout: ai?.timeout ?? {} }
  }

  private storedPolicy(conversationId: string): RoutingPolicy | undefined {
    const conversation = conversationRepo.get(conversationId)
    return conversation?.providerId && conversation.model ? this.policyFor({ providerId: conversation.providerId, model: conversation.model }) : undefined
  }

  /** The task's folder for an action that writes files: refused while a turn could be writing them too. */
  private idleWorkspace(conversationId: string): string {
    const workspace = this.sessionWorkspace(conversationId)
    if (!workspace) throw new Error('This task has no workspace folder, so it has no changes to undo.')
    if (this.hasRunningTurn(conversationId)) throw new Error('Stop the running turn before undoing its changes.')
    return workspace
  }

  /**
   * The review state of a task changed: the window should refetch. During a turn the event rides
   * its stream. Otherwise there is no stream to ride, so the event names the task instead.
   */
  private emitReview(conversationId: string, revision: number): void {
    for (const [streamId, owner] of this.eventStreams) {
      if (owner.conversationId === conversationId && this.active.has(streamId)) return this.emit({ streamId, kind: 'review', revision })
    }
    this.emitWire({ streamId: `review:${conversationId}`, kind: 'review', revision, conversationId })
  }

  private sessionWorkspace(conversationId: string): string | undefined {
    if (typeof conversationId !== 'string' || !conversationId.trim() || conversationId.length > 256) throw new Error('Invalid task id.')
    const conversation = conversationRepo.get(conversationId)
    if (!conversation) throw new Error('Task was not found.')
    return conversation.workspacePath
  }

  /** Emit an ask_user_question and block until the user answers or dismisses it. */
  private requestQuestion(
    streamId: string,
    q: { question: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean; allowOther?: boolean },
    signal?: AbortSignal
  ): Promise<string[]> {
    const id = nanoid()
    const ask: QuestionAsk = {
      id,
      question: q.question,
      options: q.options,
      ...(q.multiSelect ? { multiSelect: true } : {}),
      ...(q.allowOther ? { allowOther: true } : {})
    }
    return new Promise<string[]>((resolvePromise) => {
      const onAbort = (): void => {
        this.pendingQuestions.delete(id)
        resolvePromise([])
      }
      if (signal?.aborted) return onAbort()
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pendingQuestions.set(id, (answers) => {
        signal?.removeEventListener('abort', onAbort)
        resolvePromise(answers)
      })
      this.notifyWaiting(streamId, 'question', `Cubex is waiting for your answer: ${q.question.slice(0, 200)}`)
      this.emit({ streamId, kind: 'question', ask })
    })
  }

  /** Run the hooks of an event nobody waits for: failures are the hook's own business. */
  private fireHooks(payload: HookPayload, cwd: string | undefined): void {
    void runHooks(getSettings().hooks, payload, cwd).catch(() => undefined)
  }

  /** Notification hooks: a permission prompt or a question just started waiting for the person. */
  private notifyWaiting(streamId: string, type: 'permission' | 'question', message: string, workspace?: string): void {
    const owner = this.eventStreams.get(streamId)
    if (!owner) return
    let cwd = workspace
    if (!cwd) {
      try { cwd = this.sessionWorkspace(owner.conversationId) } catch { /* no folder: the hook runs where Cubex does */ }
    }
    this.fireHooks({ event: 'Notification', session_id: owner.conversationId, notification_type: type, message, cwd }, cwd)
  }

  /** Remember which files the agent read and edited, for the note that follows a summary. */
  private trackWorkingSet(conversationId: string, call: ToolCall): void {
    if (call.name === 'read_file') {
      const path = (call.input as { path?: unknown } | null)?.path
      if (typeof path === 'string') this.workingSets.noteRead(conversationId, path)
    } else if (FILE_MUTATION_TOOLS.has(call.name)) {
      for (const path of fileMutationPaths(call.name, call.input)) this.workingSets.noteEdit(conversationId, path)
    }
  }

  resolveQuestion(id: string, answers: string[]): void {
    const resolver = this.pendingQuestions.get(id)
    if (resolver) {
      this.pendingQuestions.delete(id)
      resolver(answers)
    }
  }

  listPlans(conversationId: string): PlanAsk[] {
    return this.plans.list(conversationId)
  }

  getPlan(id: string): PlanAsk | null {
    return this.plans.get(id)
  }

  readCommandOutput(conversationId: string, id: string, offset?: number, limit?: number): CommandOutputPage {
    if (!conversationRepo.get(conversationId)) throw new Error('Task was not found.')
    const page = this.commandOutputs.read(conversationId, id, { offset, limit })
    if (!page) throw new Error('Saved command output is unavailable. Older outputs may have expired.')
    return page
  }

  commandOutputPath(conversationId: string, id: string): string {
    if (!conversationRepo.get(conversationId)) throw new Error('Task was not found.')
    return this.commandOutputs.revealPath(conversationId, id)
  }

  resolvePlan(id: string, decision: PlanDecision, feedback?: string): void {
    this.planReviews.resolve(id, decision, feedback)
  }

  /** Tear down external MCP server connections and child processes (app quit). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const [, c] of this.active) c.abort()
    this.active.clear()
    for (const [, c] of this.goalChecks) c.abort()
    this.goalChecks.clear()
    // The agents kept running for consultations go with the app, with whatever they started.
    this.acpSessions.dispose()
    this.pendingPermissions.clear()
    this.pendingQuestions.clear()
    this.mcp.disposeAll()
    // Synchronous: the quit path has no chance to await a kill before exit.
    this.processManager.disposeSync()
  }

  private captureUsage(event: AIStreamEvent, conversationId?: string): void {
    // Record from `completed` only. The gateway preserves the adapter's final
    // response, or synthesizes one from accumulated events when needed. Also
    // handling standalone `usage` events would double-count tokens and cost.
    // Attribute to the response's own provider/model so a fallback turn is not
    // misattributed to the previous target.
    if (event.type !== 'completed') return
    const usage = event.response.usage
    if (!usage) return
    const providerId = event.response.provider
    const modelId = event.response.model
    const model = this.providers.getModelInfo(providerId, modelId)
    const execution = model?.location === 'local' ? 'local' : 'cloud'
    // The task is recorded with the cost: the session budget and the usage view read it back by task.
    recordUsage({ providerId, model, modelId, usage, execution, ...(conversationId ? { conversationId } : {}) })
  }

  cancel(streamId: string): void {
    const controller = this.active.get(streamId)
    if (controller && !controller.signal.aborted) {
      // The loop's `finally` retires the stream. Deleting here would let a
      // restart with the same id run while the dying loop still emits.
      controller.abort()
      // Stop ends this turn's own work and nothing else. The abort above ends a foreground command in
      // flight, and cancelTurn ends the background tasks this turn started. A task from an earlier turn
      // (a dev server the user is looking at) is not this turn's work: it keeps running until the user
      // stops it, the task is deleted (forgetConversation) or the app quits (dispose).
      const owner = this.eventStreams.get(streamId)
      if (owner?.conversationId) {
        void this.processManager.cancelTurn(owner.conversationId, streamId)
      }
      logger.info('Chat stream cancelled by user', { status: 'cancelled' })
    }
  }

  /** Cascade for conversation delete: stop its streams and drop its plans, outputs and checkpoints. */
  forgetConversation(conversationId: string): void {
    for (const [streamId, owner] of this.eventStreams) {
      if (owner.conversationId === conversationId) this.cancel(streamId)
    }
    this.checkpoints.clear(conversationId)
    this.compaction.forget(conversationId)
    this.workingSets.forget(conversationId)
    this.startedSessions.delete(conversationId)
    this.budget.forget(conversationId)
    this.lastTurn.delete(conversationId)
    this.cancelGoalCheck(conversationId)
    this.peerTranscripts.forgetConversation(conversationId)
    this.acpSessions.forgetConversation(conversationId)
    this.forgotten.add(conversationId)
    for (const [label, drop] of [
      ['plans', () => this.plans.deleteConversation(conversationId)],
      ['turn log', () => this.turnLog.deleteConversation(conversationId)],
      ['command output', () => this.commandOutputs.deleteConversation(conversationId)],
      ['session changes', () => this.sessionChanges.deleteConversation(conversationId)],
      ['processes', () => this.processManager.deleteConversation(conversationId)]
    ] as const) {
      try { drop() } catch (error) { logger.warn(`Could not delete ${label} for a conversation: ${(error as Error).message}`) }
    }
  }

  cancelAll(): void {
    for (const [, c] of this.active) c.abort()
    this.active.clear()
    this.pendingPermissions.clear()
    this.pendingQuestions.clear()
    void this.processManager.dispose()
  }
}

/** A short human title for a tool call, e.g. "Edit src/app.ts". */
function describeToolCall(call: ToolCall): string {
  const input = (call.input ?? {}) as Record<string, unknown>
  const path = typeof input.path === 'string' ? input.path : undefined
  switch (call.name) {
    case 'glob_files':
      return `Find ${typeof input.pattern === 'string' ? input.pattern : 'files'}`
    case 'read_plan':
      return 'Read saved plan'
    case 'read_command_output':
      return 'Read command output'
    case 'read_file':
      return `Read ${path ?? ''}`.trim()
    case 'write_file':
      return `Write ${path ?? ''}`.trim()
    case 'edit_file':
      return `Edit ${path ?? ''}`.trim()
    case 'multi_edit': {
      const edits = Array.isArray(input.edits) ? input.edits.length : 0
      return `Edit ${path ?? ''}${edits > 0 ? ` (${edits} edit${edits === 1 ? '' : 's'})` : ''}`.trim()
    }
    case 'apply_patch': {
      const files = [...new Set(fileMutationPaths('apply_patch', input))]
      return files.length === 1 ? `Patch ${files[0]}` : files.length > 1 ? `Patch ${files.length} files` : 'Apply patch'
    }
    case 'run_command': {
      const cmd = typeof input.command === 'string' ? input.command : ''
      return `Run ${cmd.length > 60 ? cmd.slice(0, 60) + '…' : cmd}`.trim()
    }
    case 'web_fetch': {
      const url = typeof input.url === 'string' ? input.url : ''
      try {
        return `Fetch ${new URL(url).hostname}`
      } catch {
        return 'Fetch URL'
      }
    }
    case 'web_search':
      return `Search "${typeof input.query === 'string' ? input.query : ''}"`
    case 'list_files':
      return `List ${path ?? '.'}`
    case 'search_files':
      return `Search "${typeof input.query === 'string' ? input.query : ''}"`
    case 'delegate_to_subagent':
      return `Subagent ${typeof input.task === 'string' ? input.task.slice(0, 100) : 'research'}`
    case CONSULT_TOOL:
      return consultTitle(call.input, getSettings().peers?.list ?? [])
    case DELEGATE_TOOL:
      return delegateTitle(call.input, getSettings().peers?.list ?? [])
    case 'goal_update':
      return input.status === 'blocked' ? 'Goal needs you' : 'Goal reported as met'
    case 'skill':
      return `Skill ${typeof input.name === 'string' ? input.name : ''}`.trim()
    case 'git_status':
      return 'Git status'
    case 'git_diff':
      return `Git diff${input.staged === true ? ' (staged)' : ''}${path ? ` ${path}` : ''}`
    case 'git_log':
      return `Git log${path ? ` ${path}` : ''}`
    case 'git_show':
      return `Git show ${typeof input.rev === 'string' ? input.rev.slice(0, 60) : ''}`.trim()
    case 'git_blame':
      return `Git blame ${path ?? ''}`.trim()
    case 'git_commit': {
      // The subject and the scope are what the user is approving; the full input is shown below the title.
      const subject = typeof input.message === 'string' ? (input.message.split('\n', 1)[0] ?? '') : ''
      const listed = Array.isArray(input.paths) ? input.paths.filter((entry): entry is string => typeof entry === 'string') : undefined
      const scope = listed === undefined ? 'all tracked changes' : listed.length <= 2 ? listed.join(', ') : `${listed.length} files`
      return `Commit: ${subject.length > 60 ? subject.slice(0, 60) + '…' : subject} (${scope.length > 80 ? scope.slice(0, 80) + '…' : scope})`
    }
    case 'git_branch':
      return `Create branch ${typeof input.name === 'string' ? input.name.slice(0, 60) : ''}`.trim()
    case 'task_output':
      return `Task output (${typeof input.task_id === 'string' ? input.task_id : ''})`
    case 'task_input':
      return `Task input (${typeof input.task_id === 'string' ? input.task_id : ''})`
    case 'task_stop':
      return `Stop task (${typeof input.task_id === 'string' ? input.task_id : ''})`
    case 'task_list':
      return 'List background tasks'
    default:
      return McpManager.describe(call.name) ?? call.name
  }
}

const PERMISSION_DETAIL_LIMIT = 8_000

/**
 * What the user approves must be what runs. Commands are shown verbatim and in
 * full; other inputs are pretty-printed. Anything clipped is labelled with the
 * hidden length so a padded payload can't hide a dangerous tail.
 */
function permissionDetail(call: ToolCall): string {
  const input = (call.input ?? {}) as Record<string, unknown>
  let text: string
  if (call.name === 'run_command' && typeof input.command === 'string') {
    text = `$ ${input.command}${typeof input.timeout_ms === 'number' ? `\n(timeout ${input.timeout_ms} ms)` : ''}`
  } else if (call.name === 'task_input' && typeof input.task_id === 'string') {
    // Windows cannot deliver Ctrl+C to a background task, so the card must not promise a signal that will not be sent.
    const interruptNote = process.platform === 'win32' ? '\nInterrupt requested (not available on Windows: nothing will be sent)' : '\nSignal: Interrupt (Ctrl+C)'
    text = `Task: ${input.task_id}${input.interrupt ? interruptNote : ''}${typeof input.text === 'string' ? `\nInput: ${input.text}` : ''}`
  } else if (call.name === 'apply_patch' && typeof input.patch === 'string') {
    // The reviewer reads the patch itself, with real line breaks, not a JSON-escaped string.
    text = input.patch
  } else if (call.name === CONSULT_TOOL) {
    // What is approved is what is sent: the whole message, to the agent named, with real line breaks.
    text = consultApprovalText(call.input, getSettings().peers?.list ?? [])
  } else if (call.name === DELEGATE_TOOL) {
    // What is approved is what is handed over: the whole task, to the agent named, in the role named.
    text = delegateApprovalText(call.input, getSettings().peers?.list ?? [])
  } else {
    try { text = JSON.stringify(input, null, 2) ?? '' } catch { text = String(input) }
  }
  if (text.length <= PERMISSION_DETAIL_LIMIT) return text
  return `${text.slice(0, PERMISSION_DETAIL_LIMIT)}\n… [${text.length - PERMISSION_DETAIL_LIMIT} more characters not shown — deny and ask for a shorter call if unsure]`
}
