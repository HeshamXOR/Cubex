import { create } from 'zustand'
import { nanoid } from 'nanoid'
import type {
  AIStreamEvent,
  GatewayEvent,
  ModelInfo,
  NormalizedAIErrorData,
  ProviderConfig,
  RoutingPolicy,
  Usage
} from '@core/types'
import { DEFAULT_RETRY_POLICY } from '@core/types'
import type { MessageContentPart, ReasoningEffort } from '@core/types'
import { defaultEffortFor, normalizeEffortFor, type EffortModel } from '@core/providers'
import type {
  ChatEvent,
  Conversation,
  ConversationComposer,
  ConversationSummary,
  ContextUsageSnapshot,
  PermissionAsk,
  PermissionDecision,
  PermissionMode,
  PlanAsk,
  PlanDecision,
  Preset,
  QuestionAsk,
  StoredMessage,
  TodoItem,
  ToolActivity
} from '../../../shared/ipc'
import type { AppSettings } from '../../../shared/settings'
import { hydrateMessageTranscript, messageDisplayBlocks, serializeMessageTranscript, type MessageTranscriptBlock } from '../../../shared/messageTranscript'
import { api } from '../lib/api'
import { applyTaskEvent } from './tasks'
import { applyContextCostEvent, noteManualSummary } from './contextCost'
import { namedSkill, useSkills } from './skills'
import { isSkillLoadFailure, skillTurnText } from '../../../shared/skillInvocation'
import type { HarnessState } from '../status/StatusIndicator'
import type { ExtraPanelTab } from '../components/panelTabs/registry'
import type { SettingsPageId } from '../views/settings/pages'

/** The right-hand panel's tabs: three built in, the rest registered in components/panelTabs. */
export type PanelTab = 'changes' | 'plan' | 'details' | ExtraPanelTab

export type ViewId =
  | 'chat'
  | 'providers'
  | 'local'
  | 'hardware'
  | 'presets'
  | 'settings'

export interface ChatTab {
  id: string
  title: string
}

/** Per-request debug info shown in the inspector. */
export interface DebugInfo {
  provider?: string
  model?: string
  requestId?: string
  status?: string
  ttftMs?: number
  totalMs?: number
  usage?: Usage
  retryCount: number
  events: string[]
  gatewayTrail: string[]
  error?: NormalizedAIErrorData
  startedAt?: number
}

export interface LiveMessage extends StoredMessage {
  blocks?: MessageTranscriptBlock[]
  transcriptTruncated?: boolean
  reasoning?: string
  /** Wall-clock start of the reasoning phase (transient, for "Thought for Ns"). */
  reasoningStart?: number
  /** Duration of the reasoning phase in ms, set once visible text begins. */
  reasoningMs?: number
  streaming?: boolean
  toolCalls?: ToolActivity[]
  /** Transient stream cursor; never persisted or used as model content. */
  lastEventSequence?: number
  iteration?: number
  nextTextBlock?: boolean
  nextReasoningBlock?: boolean
  /** Names only while arguments stream; partial tool arguments never enter UI/history. */
  preparingTools?: { index: number; name?: string }[]
  /** Image/file attachments the user sent with this message (for display). */
  attachments?: MessageContentPart[]
}

/** Bound individual in-memory drafts without adding another persistence layer. */
export const COMPOSER_MAX_LENGTH = 500_000
const WELCOME_DRAFT = '__cubex_welcome_draft__'

/** What `sendMessage` may be given besides the text. */
export interface SendOptions {
  attachments?: MessageContentPart[]
}

interface CubexState {
  view: ViewId
  setView: (v: ViewId) => void
  /** The page of Settings that is open. It lives here so a link elsewhere in the app can open Settings on a page. */
  settingsPage: SettingsPageId
  setSettingsPage: (page: SettingsPageId) => void
  /** Text queued to be appended into the composer (e.g. an @file mention). */
  composerInsert?: string
  appendToComposer: (text: string) => void
  consumeComposerInsert: () => void
  composerText: string
  composerRevision: number
  setComposerText: (value: string | ((current: string) => string)) => void
  submitComposer: () => Promise<void>
  startingRequest: boolean
  panelOpen: boolean
  togglePanel: () => void
  panelTab: PanelTab
  setPanelTab: (t: PanelTab) => void
  /** The file the review panel should show, when something in the thread pointed at it. */
  reviewFile?: string
  /** Open the review panel on its Changes tab, optionally on one file. */
  openReview: (file?: string) => void
  /** Choose which changed file the review panel shows, without opening anything. */
  setReviewFile: (file?: string) => void

  providers: ProviderConfig[]
  models: Record<string, ModelInfo[]>
  activeProviderId?: string
  activeModel?: string
  /** Once a selection existed, provider refreshes must not silently choose a replacement. */
  providerSelectionMade: boolean
  loadProviders: () => Promise<void>
  setActive: (providerId: string, model: string) => void
  loadModels: (providerId: string) => Promise<void>

  presets: Preset[]
  activePresetId?: string
  loadPresets: () => Promise<void>
  applyPreset: (id: string) => void

  conversations: ConversationSummary[]
  activeConversation?: Conversation
  tabs: ChatTab[]
  activeTabId?: string
  loadConversations: () => Promise<void>
  newConversation: (options?: { forSend?: boolean }) => Promise<Conversation | undefined>
  openConversation: (id: string) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  renameActiveConversation: (id: string, title: string) => Promise<void>
  togglePin: (id: string) => Promise<void>
  toggleArchive: (id: string) => Promise<void>
  editUserMessage: (id: string, text: string) => Promise<void>
  deleteMessage: (id: string) => Promise<void>
  selectTab: (id: string) => Promise<void>
  closeTab: (id: string) => void

  liveMessages: LiveMessage[]
  status: HarnessState
  statusDetail?: string
  streamId?: string
  /** Model-managed task checklist for the active turn (todo_write tool). */
  todos: TodoItem[]
  /** Wall-clock ms when the current generation started (for the elapsed timer). */
  genStartedAt?: number
  debug: DebugInfo
  /** Last actual request's context estimate and optional provider measurement. */
  contextUsage?: ContextUsageSnapshot

  /** Composer options. */
  permissionMode: PermissionMode
  setPermissionMode: (m: PermissionMode) => void
  cyclePermissionMode: () => void
  longContext: boolean
  toggleLongContext: () => void
  /** Ids of the other agents the model may ask in the open chat. Each chat keeps its own. */
  peers: string[]
  togglePeer: (id: string) => void
  /** Pending tool-permission request awaiting the user's decision. */
  pendingPermission?: PermissionAsk
  resolvePermission: (id: string, decision: PermissionDecision) => void
  /** Pending ask_user_question awaiting the user's answer. */
  pendingQuestion?: QuestionAsk
  resolveQuestion: (id: string, answers: string[]) => void
  /** Pending exit_plan_mode plan awaiting the user's approval decision. */
  pendingPlan?: PlanAsk
  plans: PlanAsk[]
  planLoadError?: string
  activePlan?: PlanAsk
  planPanelOpen: boolean
  openPlan: (plan: PlanAsk) => void
  closePlan: () => void
  loadPlans: (conversationId: string) => Promise<void>
  resolvePlan: (id: string, decision: PlanDecision, feedback?: string) => Promise<void>
  conversationRuns: Record<string, ConversationRun>
  streamOwners: Record<string, string>
  /** Composer attachments (image/file content parts) for the next message. */
  attachments: MessageContentPart[]
  addAttachment: (part: MessageContentPart) => void
  removeAttachment: (index: number) => void
  clearAttachments: () => void
  effort?: ReasoningEffort
  setEffort: (e: ReasoningEffort | undefined) => void
  maxTokens: number
  setMaxTokens: (v: number) => void

  /** Per-conversation system prompt override set via /system. */
  sessionSystem?: string
  /** Per-conversation goal set via /goal (kept in the system context each turn). */
  sessionGoal?: string
  setGoal: (goal: string | undefined) => void

  /** Resolves true once the message went out (a failure after that shows in the thread) and false when it was not sent. `options.attachments` sends a queued message and leaves the composer alone. */
  sendMessage: (text: string, options?: SendOptions) => Promise<boolean>
  cancel: () => void
  regenerate: () => Promise<void>
  clearActive: () => Promise<void>
  compactActive: () => Promise<void>
  /** The conversation whose older turns are being summarized right now. */
  compactingId?: string
  /** Why the last summary attempt failed, shown until dismissed. */
  compactError?: string
  dismissCompactError: () => void
  restoreFullContext: () => Promise<void>
  /** Handle a "/command"; returns true if it was a recognized command. */
  runSlashCommand: (input: string) => Promise<boolean>

  settings?: AppSettings
  loadSettings: () => Promise<void>
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>
  pickWorkspace: () => Promise<void>
  setWorkspace: (path: string) => Promise<void>
  clearWorkspace: () => Promise<void>

  _initChatEvents: () => void
}

/** The live turn follows its conversation while the user views another task. */
type ConversationRun = Pick<CubexState,
  'activeConversation' | 'liveMessages' | 'status' | 'statusDetail' | 'streamId' |
  'genStartedAt' | 'debug' | 'contextUsage' | 'todos' | 'pendingPermission' | 'pendingQuestion' |
  'pendingPlan' | 'permissionMode' | 'sessionSystem' | 'sessionGoal' | 'attachments' |
  'composerText' | 'composerRevision' | 'composerInsert' | 'startingRequest'>

function captureRun(s: CubexState): ConversationRun {
  return {
    activeConversation: s.activeConversation, liveMessages: s.liveMessages,
    status: s.status, statusDetail: s.statusDetail, streamId: s.streamId,
    genStartedAt: s.genStartedAt, debug: s.debug, contextUsage: s.contextUsage, todos: s.todos,
    pendingPermission: s.pendingPermission, pendingQuestion: s.pendingQuestion,
    pendingPlan: s.pendingPlan, permissionMode: s.permissionMode,
    sessionSystem: s.sessionSystem, sessionGoal: s.sessionGoal, attachments: s.attachments,
    composerText: s.composerText, composerRevision: s.composerRevision,
    composerInsert: s.composerInsert, startingRequest: s.startingRequest
  }
}

function cacheActiveRun(s: CubexState): Record<string, ConversationRun> {
  const id = s.activeConversation?.id ?? WELCOME_DRAFT
  return { ...s.conversationRuns, [id]: captureRun(s) }
}

function mergePlan(plans: PlanAsk[], plan: PlanAsk): PlanAsk[] {
  return [plan, ...plans.filter((p) => p.id !== plan.id)]
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
}

function emptyDebug(): DebugInfo {
  return { retryCount: 0, events: [], gatewayTrail: [] }
}

/** Rebuild a stored message for display, restoring image/file attachments. */
function hydrateMessage(m: StoredMessage, conversationId: string): LiveMessage {
  const restored = { ...m, ...hydrateMessageTranscript(m, conversationId) }
  if (m.contentJson) {
    try {
      const parts = JSON.parse(m.contentJson) as MessageContentPart[]
      const attachments = parts.filter((p) => p.type === 'image' || p.type === 'file')
      if (attachments.length) return { ...restored, attachments }
    } catch {
      /* fall through to text-only */
    }
  }
  return restored
}

/** Compose the effective system prompt from base + workspace + goal context. */
function composeSystem(
  base: string | undefined,
  ctx: { workspace?: string; goal?: string }
): string | undefined {
  const parts: string[] = []
  if (base) parts.push(base)
  if (ctx.workspace) parts.push(`The user's active workspace folder is: ${ctx.workspace}`)
  if (ctx.goal) parts.push(`Current goal for this session. Keep working toward it:\n${ctx.goal}`)
  return parts.length ? parts.join('\n\n') : undefined
}

let effortSelectionVersion = 0
let providerLoadVersion = 0
const modelLoadVersions = new Map<string, symbol>()

/** Mirror the main-process routing policy for selection; it remains the authority. */
export function selectableProvider(provider: ProviderConfig, settings?: AppSettings): boolean {
  if (!provider.enabled) return false
  if (!settings?.privacy.localOnly) return true
  switch (provider.kind) {
    case 'mock': case 'mock-local': case 'ollama': case 'lmstudio': case 'llamacpp': return true
    case 'custom': case 'openai-compat': return provider.accessType === 'local'
    default: return false
  }
}

function clearedProviderSelection(): Partial<CubexState> {
  effortSelectionVersion++
  return { activeProviderId: undefined, activeModel: undefined, activePresetId: undefined, effort: undefined, providerSelectionMade: true }
}

function applyProviderPrivacy(state: CubexState, settings: AppSettings): Partial<CubexState> {
  for (const provider of state.providers) {
    if (!selectableProvider(provider, settings)) modelLoadVersions.delete(provider.id)
  }
  const provider = state.providers.find((candidate) => candidate.id === state.activeProviderId)
  return {
    settings,
    models: Object.fromEntries(Object.entries(state.models).filter(([id]) => {
      const candidate = state.providers.find((entry) => entry.id === id)
      return candidate && selectableProvider(candidate, settings)
    })),
    ...(provider && !selectableProvider(provider, settings) ? clearedProviderSelection() : {})
  }
}

function effortModelFor(state: CubexState, providerId?: string, modelId?: string): EffortModel {
  return (providerId ? state.models[providerId]?.find((model) => model.id === modelId) : undefined) ?? { id: modelId ?? '' }
}

/**
 * What a conversation records about the composer: its provider and model, and the choices that belong to them.
 * Keys stay present when empty so that saving them clears what an earlier model left behind.
 */
function selectionPatch(s: Pick<CubexState, 'activeProviderId' | 'activeModel' | 'activePresetId' | 'effort' | 'longContext' | 'maxTokens' | 'peers'>): Pick<Conversation, 'providerId' | 'model' | 'presetId' | 'composer'> {
  const composer: ConversationComposer = { longContext: s.longContext, maxTokens: s.maxTokens, ...(s.peers.length > 0 ? { peers: s.peers } : {}), ...(s.effort ? { effort: s.effort } : {}) }
  return { providerId: s.activeProviderId, model: s.activeModel, presetId: s.activePresetId, composer }
}

/** Save the live choices to the conversation that is open, and nowhere else. Another chat keeps its own. */
function persistSelection(): void {
  const state = useStore.getState()
  const conversation = state.activeConversation
  if (!conversation) return
  const patch = selectionPatch(state)
  void api.updateConversation(conversation.id, patch).catch(() => undefined)
  useStore.setState((s) => ({
    activeConversation: s.activeConversation?.id === conversation.id ? { ...s.activeConversation, ...patch } : s.activeConversation,
    conversations: s.conversations.map((entry) => (entry.id === conversation.id ? { ...entry, providerId: patch.providerId, model: patch.model } : entry))
  }))
}

/**
 * The composer state a conversation asks for. Empty when its provider has been removed or switched off, so the
 * choice already on screen stands until the person makes another.
 */
function selectionFor(state: CubexState, conversation: Conversation): Partial<CubexState> {
  const provider = conversation.providerId ? state.providers.find((candidate) => candidate.id === conversation.providerId) : undefined
  if (!provider || !selectableProvider(provider, state.settings)) return {}
  const model = conversation.model || provider.defaultModel || ''
  const info = effortModelFor(state, provider.id, model)
  return {
    activeProviderId: provider.id,
    activeModel: model,
    activePresetId: conversation.presetId,
    providerSelectionMade: true,
    // A chat from before choices were kept has none stored: it starts from the model's default.
    effort: normalizeEffortFor(provider.kind, conversation.composer ? conversation.composer.effort : defaultEffortFor(provider.kind, info), info),
    longContext: conversation.composer?.longContext ?? false,
    peers: conversation.composer?.peers ?? [],
    maxTokens: conversation.composer?.maxTokens ?? state.settings?.ai.maxOutputTokens ?? state.maxTokens
  }
}

export const useStore = create<CubexState>((set, get) => ({
  view: 'chat',
  setView: (v) => set({ view: v }),
  settingsPage: 'general',
  setSettingsPage: (page) => set({ settingsPage: page }),
  composerInsert: undefined,
  appendToComposer: (text) => set((s) => ({ composerInsert: (s.composerInsert ?? '') + text })),
  consumeComposerInsert: () => set({ composerInsert: undefined }),
  composerText: '',
  composerRevision: 0,
  startingRequest: false,
  setComposerText: (value) => set((s) => ({
    composerText: (typeof value === 'function' ? value(s.composerText) : value).slice(0, COMPOSER_MAX_LENGTH),
    composerRevision: s.composerRevision + 1
  })),
  submitComposer: async () => {
    const state = get()
    const text = state.composerText.trim()
    if (!text || state.startingRequest || state.liveMessages.some((message) => message.streaming)) return
    const owner = state.activeConversation?.id ?? WELCOME_DRAFT
    const [updateOwner] = conversationAccess(set, get, owner)
    if (!text.startsWith('/')) { await state.sendMessage(text); return }
    try {
      const handled = await state.runSlashCommand(text)
      if (handled) {
        const settledOwner = owner === WELCOME_DRAFT && !get().conversationRuns[WELCOME_DRAFT]
          ? get().activeConversation?.id ?? owner : owner
        const [updateDraft] = conversationAccess(set, get, settledOwner)
        updateDraft((current) => current.composerRevision === state.composerRevision
          ? { composerText: '', composerRevision: current.composerRevision + 1 } : {})
      } else if ((get().activeConversation?.id ?? WELCOME_DRAFT) === owner) {
        await get().sendMessage(text)
      }
    } catch (cause) {
      updateOwner({ status: 'error', statusDetail: cause instanceof Error ? cause.message : 'The command could not be completed.' })
    }
  },
  panelOpen: false,
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  panelTab: 'changes',
  setPanelTab: (t) => set({ panelTab: t }),
  reviewFile: undefined,
  openReview: (file) => set({ panelOpen: true, panelTab: 'changes', reviewFile: file }),
  setReviewFile: (file) => set({ reviewFile: file }),

  providers: [],
  models: {},
  providerSelectionMade: false,
  loadProviders: async () => {
    const version = ++providerLoadVersion
    const providers = await api.listProviders()
    if (version !== providerLoadVersion) return
    // Metadata belongs to the configuration that requested it. Invalidate old
    // requests before refreshing the selected provider, including key edits.
    modelLoadVersions.clear()
    const state = get()
    const models = Object.fromEntries(Object.entries(state.models).filter(([id]) => {
      const previous = state.providers.find((provider) => provider.id === id)
      const current = providers.find((provider) => provider.id === id)
      return current && selectableProvider(current, state.settings) && JSON.stringify(previous) === JSON.stringify(current)
    }))
    const active = providers.find((provider) => provider.id === state.activeProviderId)
    if (state.activeProviderId && (!active || !selectableProvider(active, state.settings))) {
      set({ providers, models, ...clearedProviderSelection() })
      return
    }
    set({ providers, models })
    const first = providers.find((provider) => selectableProvider(provider, state.settings))
    if (!state.activeProviderId && !state.providerSelectionMade && first) {
      get().setActive(first.id, first.defaultModel ?? '')
    }
    const selected = get().activeProviderId
    // Saving a provider succeeded even when its model endpoint is unavailable.
    if (selected) await get().loadModels(selected).catch(() => undefined)
  },
  setActive: (providerId, model) => {
    const state = get()
    const provider = state.providers.find((p) => p.id === providerId)
    if (!provider || !selectableProvider(provider, state.settings)) return
    effortSelectionVersion++
    const kind = provider.kind
    set({
      activeProviderId: providerId,
      activeModel: model,
      providerSelectionMade: true,
      // Defaults are model-specific; unsupported models send no effort.
      effort: kind ? defaultEffortFor(kind, effortModelFor(state, providerId, model)) : undefined,
      // A model that was picked as a preset is no longer that preset.
      activePresetId: undefined
    })
    persistSelection()
  },
  loadModels: async (providerId) => {
    const initial = get()
    const provider = initial.providers.find((candidate) => candidate.id === providerId)
    if (!provider || !selectableProvider(provider, initial.settings)) return
    const version = Symbol(providerId)
    const selectionVersion = effortSelectionVersion
    modelLoadVersions.set(providerId, version)
    const models = await api.listModels(providerId)
    set((s) => {
      if (modelLoadVersions.get(providerId) !== version ||
        s.providers.find((candidate) => candidate.id === providerId) !== provider ||
        !selectableProvider(provider, s.settings)) return {}
      const catalog = { ...s.models, [providerId]: models }
      if (s.activeProviderId !== providerId) return { models: catalog }
      // A configured/manual model can be valid even when /models omits it.
      // Only choose the first model while the original empty selection owns the request.
      const activeModel = s.activeModel || (initial.activeProviderId === providerId && selectionVersion === effortSelectionVersion ? models[0]?.id : s.activeModel)
      const model = models.find((m) => m.id === activeModel) ?? { id: activeModel ?? '' }
      const kind = s.providers.find((p) => p.id === providerId)?.kind
      return {
        models: catalog,
        activeModel,
        effort: kind ? (!s.activeModel ? defaultEffortFor(kind, model) : normalizeEffortFor(kind, s.effort, model)) : undefined
      }
    })
  },

  presets: [],
  loadPresets: async () => set({ presets: await api.listPresets() }),
  applyPreset: (id) => {
    const state = get()
    const p = state.presets.find((x) => x.id === id)
    if (!p) return
    const provider = state.providers.find((candidate) => candidate.id === p.providerId)
    if (!provider || !selectableProvider(provider, state.settings)) return
    const selectionVersion = ++effortSelectionVersion
    const kind = state.providers.find((x) => x.id === p.providerId)?.kind
    set({
      activePresetId: id,
      activeProviderId: p.providerId,
      activeModel: p.model,
      providerSelectionMade: true,
      effort: kind ? normalizeEffortFor(kind, p.params?.reasoningEffort, effortModelFor(state, p.providerId, p.model)) : undefined,
      ...(p.params?.maxOutputTokens !== undefined ? { maxTokens: p.params.maxOutputTokens } : {})
    })
    persistSelection()
    void get().loadModels(p.providerId).then(() => {
      const current = get()
      // An explicit selection (including Default) while metadata loads wins.
      if (selectionVersion !== effortSelectionVersion || current.activePresetId !== id ||
        current.activeProviderId !== p.providerId || current.activeModel !== p.model) return
      const currentKind = current.providers.find((provider) => provider.id === p.providerId)?.kind
      set({ effort: currentKind ? normalizeEffortFor(currentKind, p.params?.reasoningEffort, effortModelFor(current, p.providerId, p.model)) : undefined })
      persistSelection()
    }).catch(() => { /* Keep the conservative selection if metadata cannot load. */ })
  },

  conversations: [],
  tabs: [],
  loadConversations: async () => set({ conversations: await api.listConversations() }),

  newConversation: async (options) => {
    const navigation = ++navigationVersion
    const { activeProviderId, activeModel, providers, settings } = get()
    const execution = providers.find((p) => p.id === activeProviderId)?.accessType === 'local' ? 'local' : 'cloud'
    const workspacePath = settings?.general.workspacePath
    const chosen = selectionPatch(get())
    const conv = await api.createConversation({
      title: 'New Chat',
      ...(activeProviderId ? { providerId: activeProviderId } : {}),
      ...(activeModel ? { model: activeModel } : {}),
      ...(chosen.presetId ? { presetId: chosen.presetId } : {}),
      ...(chosen.composer ? { composer: chosen.composer } : {}),
      // Stamp the active project so the sidebar can group chats under it.
      ...(workspacePath ? { workspacePath } : {}),
      execution
    })
    if (navigation !== navigationVersion) { await get().loadConversations(); return }
    const current = get()
    const carryDraft = !current.activeConversation
    const runs = cacheActiveRun(current)
    if (carryDraft) delete runs[WELCOME_DRAFT]
    set({
      conversationRuns: runs,
      activeConversation: conv,
      liveMessages: [],
      attachments: carryDraft ? current.attachments : [],
      composerText: carryDraft ? current.composerText : '',
      composerRevision: carryDraft ? current.composerRevision : 0,
      composerInsert: carryDraft ? current.composerInsert : undefined,
      startingRequest: carryDraft && !!options?.forSend ? current.startingRequest : false,
      status: 'idle',
      debug: emptyDebug(),
      contextUsage: undefined,
      todos: [],
      streamId: undefined,
      pendingPlan: undefined,
      pendingQuestion: undefined,
      pendingPermission: undefined,
      plans: [], activePlan: undefined, planPanelOpen: false, planLoadError: undefined,
      reviewFile: undefined,
      compactError: undefined,
      view: 'chat',
      sessionSystem: undefined,
      sessionGoal: undefined,
      tabs: [...get().tabs, { id: conv.id, title: conv.title }],
      activeTabId: conv.id
    })
    await get().loadConversations().catch(() => undefined)
    return conv
  },

  openConversation: async (id) => {
    const navigation = ++navigationVersion
    const conv = await api.getConversation(id)
    if (!conv || navigation !== navigationVersion) return
    const tabs = get().tabs.some((t) => t.id === id)
      ? get().tabs
      : [...get().tabs, { id: conv.id, title: conv.title }]
    const runs = cacheActiveRun(get())
    const run = runs[id]
    // This chat's own model and choices, not whatever the chat before it left in the composer.
    const selection = selectionFor(get(), conv)
    const selectionVersion = ++effortSelectionVersion
    set({
      conversationRuns: runs,
      liveMessages: conv.messages.map((message) => hydrateMessage(message, conv.id)),
      attachments: [],
      composerText: '', composerRevision: 0, composerInsert: undefined, startingRequest: false,
      status: 'idle',
      debug: emptyDebug(),
      contextUsage: undefined,
      todos: [],
      streamId: undefined,
      pendingPlan: undefined, pendingQuestion: undefined, pendingPermission: undefined,
      sessionSystem: undefined, sessionGoal: undefined,
      ...run,
      ...selection,
      // A chat that has not run in this session starts in the default mode, not in the previous chat's.
      permissionMode: run?.permissionMode ?? 'default',
      // The database is the source of truth for metadata edited while this run was cached.
      activeConversation: run?.activeConversation
        ? {
            ...run.activeConversation,
            title: conv.title, pinned: conv.pinned, archived: conv.archived, workspacePath: conv.workspacePath,
            contextStartMessageId: conv.contextStartMessageId, contextSummary: conv.contextSummary, contextSummaryAt: conv.contextSummaryAt
          }
        : conv,
      plans: [], activePlan: run?.pendingPlan, planPanelOpen: !!run?.pendingPlan, planLoadError: undefined,
      reviewFile: undefined,
      compactError: undefined,
      ...(run?.pendingPlan ? { panelOpen: true, panelTab: 'plan' as const } : {}),
      view: 'chat',
      tabs,
      activeTabId: id
    })
    // The effort levels depend on the model's metadata, which may not have loaded for this provider yet.
    const kept = selection.activeProviderId
    if (kept && !get().models[kept]?.length) {
      void get().loadModels(kept).then(() => {
        const now = get()
        if (selectionVersion !== effortSelectionVersion || now.activeConversation?.id !== conv.id || now.activeProviderId !== kept) return
        const kind = now.providers.find((p) => p.id === kept)?.kind
        set({ effort: kind ? normalizeEffortFor(kind, conv.composer?.effort, effortModelFor(now, kept, now.activeModel)) : undefined })
      }).catch(() => undefined)
    }
    await get().loadPlans(id)
  },

  deleteConversation: async (id) => {
    const running = id === get().activeConversation?.id ? get().streamId : get().conversationRuns[id]?.streamId
    if (running) await api.cancelChat(running)
    await api.deleteConversation(id)
    const tabs = get().tabs.filter((t) => t.id !== id)
    const wasActive = get().activeConversation?.id === id
    set({
      tabs,
      conversationRuns: Object.fromEntries(Object.entries(get().conversationRuns).filter(([key]) => key !== id)),
      streamOwners: Object.fromEntries(Object.entries(get().streamOwners).filter(([, owner]) => owner !== id)),
      ...(wasActive ? { activeConversation: undefined, liveMessages: [], attachments: get().conversationRuns[WELCOME_DRAFT]?.attachments ?? [], composerText: get().conversationRuns[WELCOME_DRAFT]?.composerText ?? '', composerRevision: get().conversationRuns[WELCOME_DRAFT]?.composerRevision ?? 0, composerInsert: undefined, startingRequest: false, activeTabId: tabs.at(-1)?.id, plans: [], activePlan: undefined, pendingPlan: undefined, pendingQuestion: undefined, pendingPermission: undefined, planPanelOpen: false, streamId: undefined, contextUsage: undefined, status: 'idle', statusDetail: undefined, genStartedAt: undefined, todos: [], debug: emptyDebug() } : {})
    })
    if (wasActive && tabs.length) await get().openConversation(tabs.at(-1)!.id)
    await get().loadConversations()
  },

  renameActiveConversation: async (id, title) => {
    await api.updateConversation(id, { title })
    set((s) => {
      // A cached background run carries its own activeConversation snapshot;
      // without this the next save of that run writes the old title back.
      const cached = s.conversationRuns[id]
      return {
        tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)),
        ...(s.activeConversation?.id === id ? { activeConversation: { ...s.activeConversation, title } } : {}),
        ...(cached?.activeConversation ? { conversationRuns: { ...s.conversationRuns, [id]: { ...cached, activeConversation: { ...cached.activeConversation, title } } } } : {})
      }
    })
    await get().loadConversations()
  },

  togglePin: async (id) => {
    const cur = get().conversations.find((c) => c.id === id)?.pinned ?? false
    await api.updateConversation(id, { pinned: !cur })
    await get().loadConversations()
  },

  toggleArchive: async (id) => {
    const cur = get().conversations.find((c) => c.id === id)?.archived ?? false
    await api.updateConversation(id, { archived: !cur })
    await get().loadConversations()
  },

  editUserMessage: async (id, text) => {
    // Truncate to before the edited message (persisting so the model's history
    // matches what the user now sees), then re-ask with the new text. Never
    // mid-turn: truncating would bypass sendMessage's streaming guard and start
    // a second agent while the first keeps running unseen.
    if (turnBusy(get())) return
    const msgs = get().liveMessages
    const idx = msgs.findIndex((m) => m.id === id)
    if (idx < 0) return
    set({ liveMessages: msgs.slice(0, idx) })
    await persistConversation(get)
    await get().sendMessage(text)
  },

  deleteMessage: async (id) => {
    if (turnBusy(get())) return
    set((s) => ({ liveMessages: s.liveMessages.filter((m) => m.id !== id) }))
    await persistConversation(get)
  },

  selectTab: async (id) => {
    if (get().activeTabId === id) { navigationVersion++; return }
    await get().openConversation(id)
  },

  closeTab: (id) => {
    navigationVersion++
    set((s) => ({ conversationRuns: cacheActiveRun(s) }))
    const tabs = get().tabs.filter((t) => t.id !== id)
    const wasActive = get().activeTabId === id
    set({ tabs })
    if (wasActive) {
      const next = tabs.at(-1)
      if (next) void get().openConversation(next.id)
      else set({ activeTabId: undefined, activeConversation: undefined, liveMessages: [], attachments: get().conversationRuns[WELCOME_DRAFT]?.attachments ?? [], composerText: get().conversationRuns[WELCOME_DRAFT]?.composerText ?? '', composerRevision: get().conversationRuns[WELCOME_DRAFT]?.composerRevision ?? 0, composerInsert: undefined, startingRequest: false, status: 'idle', streamId: undefined, pendingPlan: undefined, pendingQuestion: undefined, pendingPermission: undefined, plans: [], activePlan: undefined, planPanelOpen: false, contextUsage: undefined })
    }
  },

  liveMessages: [],
  status: 'idle',
  debug: emptyDebug(),

  todos: [],
  conversationRuns: {},
  streamOwners: {},

  permissionMode: 'default',
  setPermissionMode: (m) => set({ permissionMode: m }),
  // Shift+Tab cycles like Claude Code: default → acceptEdits → plan → bypass.
  cyclePermissionMode: () =>
    set((s) => {
      const order: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypass']
      return { permissionMode: order[(order.indexOf(s.permissionMode) + 1) % order.length]! }
    }),
  longContext: false,
  toggleLongContext: () => {
    set((s) => ({ longContext: !s.longContext }))
    persistSelection()
  },
  peers: [],
  togglePeer: (id) => {
    set((s) => ({ peers: s.peers.includes(id) ? s.peers.filter((entry) => entry !== id) : [...s.peers, id] }))
    persistSelection()
  },
  pendingPermission: undefined,
  resolvePermission: (id, decision) => {
    void api.resolvePermission(id, decision)
    set({ pendingPermission: undefined, status: 'working', statusDetail: undefined })
  },
  resolveQuestion: (id, answers) => {
    void api.resolveQuestion(id, answers)
    set({ pendingQuestion: undefined, status: 'working', statusDetail: undefined })
  },
  pendingPlan: undefined,
  plans: [],
  activePlan: undefined,
  planPanelOpen: false,
  openPlan: (plan) => set({ activePlan: plan, planPanelOpen: true, panelOpen: true, panelTab: 'plan' }),
  closePlan: () => set((s) => ({ planPanelOpen: false, panelTab: s.panelTab === 'plan' ? 'changes' : s.panelTab })),
  loadPlans: async (conversationId) => {
    let plans: PlanAsk[]
    try {
      plans = await api.listPlans(conversationId)
    } catch {
      set((s) => s.activeConversation?.id === conversationId ? { planLoadError: 'Saved plans could not be loaded.' } : {})
      return
    }
    set((s) => {
      if (s.activeConversation?.id !== conversationId) return {}
      const history = new Map(plans.map((p) => [p.id, p]))
      for (const local of s.plans) {
        const remote = history.get(local.id)
        if (!remote || (local.resolvedAt ?? 0) > (remote.resolvedAt ?? 0) ||
            (local.status && local.status !== 'pending' && remote.status === 'pending')) history.set(local.id, local)
      }
      if (s.pendingPlan) history.set(s.pendingPlan.id, s.pendingPlan)
      const merged = [...history.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      return { plans: merged, activePlan: merged.find((p) => p.id === s.activePlan?.id) ?? s.activePlan ?? merged[0], planLoadError: undefined }
    })
  },
  resolvePlan: async (id, decision, feedback) => {
    const pending = get().pendingPlan
    if (pending?.id !== id) throw new Error('This plan is no longer waiting for review.')
    const owner = pending.conversationId ?? get().activeConversation?.id
    if (!owner) throw new Error('The plan has no conversation.')
    const originatingStream = get().streamId
    const originatingMode = get().permissionMode
    await api.resolvePlan(id, decision, feedback)
    const [updateOwner] = conversationAccess(set, get, owner)
    updateOwner((s) => ({
      ...(s.pendingPlan?.id === id ? { pendingPlan: undefined } : {}),
      ...(s.pendingPlan?.id === id && originatingStream && s.streamId === originatingStream
        ? { status: 'working', statusDetail: decision === 'reject' ? 'Revising plan' : 'Implementing plan' } : {}),
      ...(s.pendingPlan?.id === id && s.streamId === originatingStream && s.permissionMode === originatingMode
        ? { permissionMode: decision === 'reject' ? 'plan' : decision } : {})
    }))
    const resolved: PlanAsk = { ...pending, status: decision === 'reject' ? 'rejected' : 'approved', decision, feedback, resolvedAt: Date.now() }
    set((s) => s.activeConversation?.id === owner ? {
      plans: mergePlan(s.plans, resolved),
      activePlan: s.activePlan?.id === id ? resolved : s.activePlan
    } : {})
  },
  attachments: [],
  addAttachment: (part) => set((s) => ({ attachments: [...s.attachments, part] })),
  removeAttachment: (index) => {
    if (Number.isInteger(index) && index >= 0) set((s) => ({ attachments: s.attachments.filter((_, i) => i !== index) }))
  },
  clearAttachments: () => set({ attachments: [] }),
  effort: undefined,
  setEffort: (e) => {
    effortSelectionVersion++
    const state = get()
    const kind = state.providers.find((p) => p.id === state.activeProviderId)?.kind
    set({ effort: kind ? normalizeEffortFor(kind, e, effortModelFor(state, state.activeProviderId, state.activeModel)) : undefined })
    persistSelection()
  },
  /** Tokens one reply may run to; 0 is Automatic (see shared/outputLimit.ts). */
  maxTokens: 0,
  setMaxTokens: (v) => {
    set({ maxTokens: Number.isFinite(v) && v > 0 ? Math.floor(v) : 0 })
    persistSelection()
  },

  sendMessage: async (text, options) => {
    const state = get()
    if (!state.activeProviderId || !state.activeModel || state.startingRequest || state.liveMessages.some((m) => m.streaming)) return false
    // A message sent from the queue brings its own attachments and must not touch what is being typed.
    const attachments = options?.attachments ?? state.attachments
    const draftRevision = !options && state.composerText.trim() === text.trim() ? state.composerRevision : undefined
    const sourceOwner = state.activeConversation?.id ?? WELCOME_DRAFT
    const [updateSource] = conversationAccess(set, get, sourceOwner)
    updateSource({ startingRequest: true })
    let conv = state.activeConversation
    if (!conv) {
      try {
        conv = await state.newConversation({ forSend: true })
      } catch (cause) {
        updateSource({ startingRequest: false, status: 'error', statusDetail: cause instanceof Error ? cause.message : 'Could not create this task.' })
        return false
      }
      if (!conv) { updateSource({ startingRequest: false }); return false }
    }
    const streamId = nanoid()
    const owner = conv.id
    // A message that names a skill ("/code-review the diff") applies it to this turn; anything else goes as typed.
    const invoked = await namedSkill(text, owner, conv.workspacePath)
    useSkills.getState().clearFailure(owner)
    if (get().activeConversation?.id !== owner && !get().conversationRuns[owner]) return false
    const [updateOwner, getOwner] = conversationAccess(set, get, owner)
    const before = getOwner()

    const userMsg: LiveMessage = {
      id: nanoid(),
      role: 'user',
      text,
      createdAt: Date.now(),
      ...(attachments.length ? { attachments } : {})
    }
    const assistantMsg: LiveMessage = {
      id: nanoid(),
      role: 'assistant',
      text: '',
      blocks: [],
      createdAt: Date.now(),
      streaming: true
    }
    updateOwner({
      liveMessages: [...getOwner().liveMessages, userMsg, assistantMsg],
      status: 'thinking',
      statusDetail: undefined,
      genStartedAt: Date.now(),
      contextUsage: undefined,
      streamId,
      debug: { ...emptyDebug(), startedAt: Date.now(), model: state.activeModel, provider: state.activeProviderId }
    })
    set((current) => ({ streamOwners: { ...current.streamOwners, [streamId]: owner } }))

    const s = state
    // Resolve again at the send boundary: model metadata may have arrived while
    // creating the task, and neither a stale preset nor ultrathink bypasses it.
    const current = get()
    const kind = current.providers.find((p) => p.id === s.activeProviderId)?.kind
    const requestedEffort = /\bultrathink\b/i.test(text) ? 'max' : s.effort
    const effort = kind ? normalizeEffortFor(kind, requestedEffort, effortModelFor(current, s.activeProviderId, s.activeModel)) : undefined
    const policy: RoutingPolicy = {
      primary: {
        providerId: s.activeProviderId!,
        model: s.activeModel!,
        params: {
          ...(s.maxTokens > 0 ? { maxOutputTokens: s.maxTokens } : {}),
          ...(effort ? { reasoningEffort: effort } : {})
        }
      },
      fallbacks: [],
      fallbackEnabled: s.settings?.ai.fallbackEnabled ?? false,
      retry: s.settings?.ai.retry ?? DEFAULT_RETRY_POLICY,
      timeout: s.settings?.ai.timeout ?? {}
    }

    const preset = s.presets.find((p) => p.id === s.activePresetId)
    const systemPrompt = composeSystem(s.sessionSystem ?? preset?.systemPrompt, {
      workspace: conv.workspacePath,
      goal: s.sessionGoal
    })
    try {
      await api.startChat({
        streamId,
        conversationId: conv.id,
        policy,
        userText: invoked ? skillTurnText(invoked.skill, invoked.request) : text,
        // Subagents and file tools are no longer user toggles; the model
        // decides when to use them (subagent spawn is asked, file writes are
        // permission-gated). Always enabled so the harness is fully capable.
        subagentEnabled: true,
        fileToolsEnabled: true,
        messageId: userMsg.id,
        permissionMode: s.permissionMode,
        longContext: s.longContext,
        ...(s.peers.length > 0 ? { peers: s.peers } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(invoked ? { skill: invoked.skill } : {})
      })
      updateOwner((current) => ({
        startingRequest: false,
        attachments: current.attachments.filter((part) => !attachments.includes(part)),
        ...(draftRevision !== undefined && current.composerRevision === draftRevision
          ? { composerText: '', composerRevision: current.composerRevision + 1 } : {})
      }))
    } catch (err) {
      // If the main process rejects before streaming starts (e.g. provider not
      // configured), settle the assistant bubble instead of leaving it spinning.
      const message = err instanceof Error ? err.message : String(err)
      // A skill that could not be loaded means the turn never started: take its two bubbles back, leave the words in
      // the composer, and say why next to it.
      if (invoked && isSkillLoadFailure(message)) {
        updateOwner((st) => ({
          startingRequest: false,
          liveMessages: st.liveMessages.filter((m) => m.id !== userMsg.id && m.id !== assistantMsg.id),
          status: before.status,
          statusDetail: before.statusDetail,
          genStartedAt: before.genStartedAt,
          contextUsage: before.contextUsage,
          debug: before.debug,
          streamId: before.streamId
        }))
        set((st) => ({ streamOwners: Object.fromEntries(Object.entries(st.streamOwners).filter(([id]) => id !== streamId)) }))
        useSkills.getState().fail(owner, message)
        // The list may be what was wrong, so read it again.
        void useSkills.getState().load(owner, conv.workspacePath)
        return false
      }
      updateOwner((st) => st.streamId !== streamId ? { startingRequest: false } : ({
        startingRequest: false,
        status: 'error',
        streamId: undefined,
        statusDetail: undefined,
        liveMessages: st.liveMessages.map((m) =>
          m.id === assistantMsg.id ? { ...m, streaming: false, error: { provider: st.activeProviderId ?? 'gateway', category: 'UNKNOWN', message, classification: 'permanent', retryable: false } } : m
        )
      }))
      set((st) => ({ streamOwners: Object.fromEntries(Object.entries(st.streamOwners).filter(([id]) => id !== streamId)) }))
      persistSettledConversation(getOwner)
    }
    return true
  },

  clearActive: async () => {
    const conv = get().activeConversation
    if (!conv || get().streamId) return
    await api.updateConversation(conv.id, { messages: [], contextStartMessageId: undefined })
    const [updateOwner] = conversationAccess(set, get, conv.id)
    updateOwner((s) => ({ liveMessages: [], status: 'idle', debug: emptyDebug(), contextUsage: undefined,
      activeConversation: s.activeConversation ? { ...s.activeConversation, messages: [], ...NO_CONTEXT_CUT } : undefined
    }))
    await get().loadConversations()
  },

  compactActive: async () => {
    // The main process summarizes the older turns and moves the boundary; the transcript stays whole.
    const { activeConversation: conv, streamId, compactingId } = get()
    if (!conv || streamId || compactingId) return
    set({ compactingId: conv.id, compactError: undefined })
    try {
      const result = await api.compactConversation(conv.id)
      if (!result.ok) {
        if (get().activeConversation?.id === conv.id) set({ compactError: result.error })
        return
      }
      const [updateOwner] = conversationAccess(set, get, conv.id)
      noteManualSummary(conv.id, result)
      updateOwner((s) => ({ contextUsage: undefined,
        activeConversation: s.activeConversation
          ? { ...s.activeConversation, contextStartMessageId: result.boundaryMessageId, contextSummary: result.summary, contextSummaryAt: Date.now() }
          : undefined
      }))
    } catch (cause) {
      if (get().activeConversation?.id === conv.id) set({ compactError: cause instanceof Error ? cause.message : 'Could not summarize this task.' })
    } finally {
      set({ compactingId: undefined })
    }
  },
  dismissCompactError: () => set({ compactError: undefined }),

  restoreFullContext: async () => {
    const { activeConversation: conv, streamId } = get()
    if (!conv?.contextStartMessageId || streamId) return
    await api.updateConversation(conv.id, { contextStartMessageId: undefined })
    const [updateOwner] = conversationAccess(set, get, conv.id)
    updateOwner((s) => ({ contextUsage: undefined,
      activeConversation: s.activeConversation ? { ...s.activeConversation, ...NO_CONTEXT_CUT } : undefined
    }))
  },

  runSlashCommand: async (input) => {
    const { parseCommand } = await import('../lib/slashCommands')
    const parsed = parseCommand(input)
    if (!parsed) return false
    const s = get()
    switch (parsed.name) {
      case 'new':
        await s.newConversation()
        return true
      case 'clear':
        await s.clearActive()
        return true
      case 'compact':
        await s.compactActive()
        return true
      case 'retry':
        await s.regenerate()
        return true
      case 'system':
        set({ sessionSystem: parsed.rest || undefined })
        return true
      case 'goal':
        set({ sessionGoal: parsed.rest || undefined })
        return true
      case 'workspace':
        await s.pickWorkspace()
        return true
      case 'model':
        set({ panelOpen: true, panelTab: 'details' })
        return true
      case 'title':
        if (parsed.rest && s.activeConversation) await s.renameActiveConversation(s.activeConversation.id, parsed.rest)
        return true
      case 'export':
        if (s.activeConversation) {
          const md = await api.exportConversation(s.activeConversation.id, 'markdown')
          await navigator.clipboard.writeText(md).catch(() => undefined)
        }
        return true
      case 'cost':
        set({ view: 'settings' })
        return true
      case 'hardware':
        set({ view: 'hardware' })
        return true
      case 'settings':
        set({ view: 'settings' })
        return true
      default:
        return false
    }
  },

  setGoal: (goal) => set({ sessionGoal: goal }),

  cancel: () => {
    const id = get().streamId
    if (id) void api.cancelChat(id)
    set((s) => ({
      status: 'cancelled',
      streamId: undefined,
      streamOwners: Object.fromEntries(Object.entries(s.streamOwners).filter(([stream]) => stream !== id)),
      statusDetail: undefined,
      pendingPlan: undefined,
      pendingPermission: undefined,
      pendingQuestion: undefined,
      plans: s.pendingPlan ? mergePlan(s.plans, { ...s.pendingPlan, status: 'cancelled' }) : s.plans,
      activePlan: s.activePlan?.id === s.pendingPlan?.id && s.activePlan ? { ...s.activePlan, status: 'cancelled' } : s.activePlan,
      liveMessages: s.liveMessages.map((m) => (m.streaming ? settleMessageActivity(m) : m))
    }))
    persistSettledConversation(get)
  },

  regenerate: async () => {
    if (turnBusy(get())) return
    const msgs = get().liveMessages
    // Drop the last user turn and everything after it (its assistant reply),
    // persist the truncation, then re-ask with the same text; no duplicate turn.
    const lastUserIdx = msgs.map((m) => m.role).lastIndexOf('user')
    if (lastUserIdx < 0) return
    const text = msgs[lastUserIdx]!.text
    set({ liveMessages: msgs.slice(0, lastUserIdx) })
    await persistConversation(get)
    await get().sendMessage(text)
  },

  settings: undefined,
  loadSettings: async () => {
    const settings = await api.getSettings()
    set((state) => ({ ...applyProviderPrivacy(state, settings), maxTokens: settings.ai.maxOutputTokens }))
  },
  saveSettings: async (patch) => {
    const settings = await api.updateSettings(patch)
    set((state) => applyProviderPrivacy(state, settings))
  },

  pickWorkspace: async () => {
    const path = await api.pickWorkspace()
    if (!path) return
    await get().setWorkspace(path)
  },
  setWorkspace: async (path) => {
    const s = get().settings
    if (!s) return
    // Keep an MRU list of the last 8 folders for the project switcher.
    const recent = [path, ...(s.general.recentWorkspaces ?? []).filter((p) => p !== path)].slice(0, 8)
    await get().saveSettings({ general: { ...s.general, workspacePath: path, recentWorkspaces: recent } })
    const active = get().activeConversation
    if (!active) return
    if (!active.workspacePath && !get().liveMessages.some((m) => m.streaming)) {
      await api.updateConversation(active.id, { workspacePath: path })
      set((state) => state.activeConversation?.id === active.id ? { activeConversation: { ...state.activeConversation, workspacePath: path } } : {})
      await get().loadConversations()
    } else if (active.workspacePath !== path) {
      await get().newConversation()
    }
  },
  clearWorkspace: async () => {
    const s = get().settings
    if (!s) return
    // Settings are merged; omitting the field would retain the previous folder.
    await get().saveSettings({ general: { ...s.general, workspacePath: '' } })
    if (get().activeConversation?.workspacePath) await get().newConversation()
  },

  _initChatEvents: () => {
    unsubscribeChatEvents?.()
    unsubscribeChatEvents = api.onChatEvent((e: ChatEvent) => {
      // A background task outlives the turn that started it, so its event is not tied to a live stream.
      if (e.kind === 'task') { applyTaskEvent(e.task); return }
      // A turn the main process started for the person, such as sending review comments: show its message and follow its stream.
      if (e.kind === 'userMessage') { attachUserTurn(set, get, e); return }
      const owner = get().streamOwners[e.streamId]
      if (!owner) return
      const [setRun, getRun] = conversationAccess(set, get, owner)
      if (e.streamId !== getRun().streamId) return
      if (e.sequence !== undefined) {
        if (!Number.isSafeInteger(e.sequence) || e.sequence < 0) return
        const last = [...getRun().liveMessages].reverse().find((message) => message.role === 'assistant')?.lastEventSequence
        // Electron IPC preserves sender order. A replay or delayed older event
        // must not append text twice or return a completed tool to running.
        if (last !== undefined && e.sequence <= last) return
        updateAssistant(setRun, (message) => ({ ...message, lastEventSequence: e.sequence }))
      }
      if (e.kind === 'gateway') applyGatewayEvent(setRun, getRun, e.event)
      else if (e.kind === 'stream') applyStreamEvent(setRun, getRun, e.event)
      else if (e.kind === 'tool') applyToolEvent(setRun, e.tool)
      else if (e.kind === 'iteration') updateAssistant(setRun, (message) => {
        if (!Number.isSafeInteger(e.iteration) || e.iteration < 0 || (message.iteration !== undefined && e.iteration <= message.iteration)) return message
        return { ...finishReasoning(message), iteration: e.iteration, nextTextBlock: true, nextReasoningBlock: true, preparingTools: undefined }
      })
      else if (e.kind === 'permission') setRun({ pendingPermission: e.ask, status: 'awaiting_input', statusDetail: 'Permission required' })
      else if (e.kind === 'question') setRun({ pendingQuestion: e.ask, status: 'awaiting_input', statusDetail: 'Question from Cubex' })
      else if (e.kind === 'todos') setRun({ todos: e.todos })
      else if (e.kind === 'context') setRun({ contextUsage: e.context })
      else if (e.kind === 'plan') {
        const plan = { ...e.ask, conversationId: e.ask.conversationId ?? owner }
        const pending = !plan.status || plan.status === 'pending'
        setRun({ pendingPlan: pending ? plan : undefined, ...(pending ? { status: 'awaiting_input', statusDetail: 'Plan ready for review' } : {}) })
        if (get().activeConversation?.id === owner) {
          set((s) => ({
            plans: mergePlan(s.plans, plan),
            activePlan: pending || s.activePlan?.id === plan.id ? plan : s.activePlan,
            ...(pending ? { planPanelOpen: true, panelOpen: true, panelTab: 'plan' as const } : {})
          }))
        }
      }
      else if (e.kind === 'mode') setRun({ permissionMode: e.mode })
      else if (e.kind === 'compacted') setRun((s) => ({
        activeConversation: s.activeConversation
          ? { ...s.activeConversation, contextStartMessageId: e.boundaryMessageId, contextSummary: e.summary, contextSummaryAt: Date.now() }
          : s.activeConversation
      }))
      else if (e.kind === 'compaction' || e.kind === 'budget') applyContextCostEvent(e, owner, setRun)
      if (e.kind === 'stream' && (e.event.type === 'completed' || e.event.type === 'error')) {
        const unresolvedPlan = getRun().pendingPlan
        setRun({ streamId: undefined, pendingPlan: undefined, pendingPermission: undefined, pendingQuestion: undefined })
        set((s) => ({
          streamOwners: Object.fromEntries(Object.entries(s.streamOwners).filter(([stream]) => stream !== e.streamId)),
          ...(unresolvedPlan && s.activeConversation?.id === owner ? {
            plans: mergePlan(s.plans, { ...unresolvedPlan, status: 'cancelled' }),
            activePlan: s.activePlan?.id === unresolvedPlan.id ? { ...s.activePlan, status: 'cancelled' as const } : s.activePlan
          } : {})
        }))
      }
    })
  }
}))

let unsubscribeChatEvents: (() => void) | undefined
let navigationVersion = 0
/** Dropping the context cut also drops the summary that stood in for the cut-off turns. */
const NO_CONTEXT_CUT = { contextStartMessageId: undefined, contextSummary: undefined, contextSummaryAt: undefined }

/** Apply a stream event to its owner, never to whichever tab happens to be visible. */
function conversationAccess(set: SetFn, get: GetFn, owner: string): [SetFn, GetFn] {
  const getRun: GetFn = () => {
    const state = get()
    return (state.activeConversation?.id ?? WELCOME_DRAFT) === owner ? state : { ...state, ...state.conversationRuns[owner] }
  }
  const setRun: SetFn = (update) => {
    set((state) => {
      if ((state.activeConversation?.id ?? WELCOME_DRAFT) === owner) return typeof update === 'function' ? update(state) : update
      const run = state.conversationRuns[owner]
      if (!run) return {}
      const projected = { ...state, ...run }
      const patch = typeof update === 'function' ? update(projected) : update
      return { conversationRuns: { ...state.conversationRuns, [owner]: captureRun({ ...projected, ...patch }) } }
    })
  }
  return [setRun, getRun]
}

/** Show the user message of a turn the main process started, and make its stream the one this conversation follows. */
function attachUserTurn(set: SetFn, get: GetFn, e: Extract<ChatEvent, { kind: 'userMessage' }>): void {
  const owner = e.conversationId
  if (!owner || get().streamOwners[e.streamId]) return
  // A task this window never opened has nothing to show the turn in, and its reply would not be saved.
  if (get().activeConversation?.id !== owner && !get().conversationRuns[owner]) return
  const [setRun, getRun] = conversationAccess(set, get, owner)
  const run = getRun()
  if (run.streamId || run.liveMessages.some((message) => message.streaming || message.id === e.messageId)) return
  const now = Date.now()
  setRun({
    liveMessages: [
      ...run.liveMessages,
      { id: e.messageId, role: 'user', text: e.text, createdAt: now },
      { id: nanoid(), role: 'assistant', text: '', blocks: [], createdAt: now, streaming: true, ...(e.sequence !== undefined ? { lastEventSequence: e.sequence } : {}) }
    ],
    status: 'thinking',
    statusDetail: undefined,
    genStartedAt: now,
    contextUsage: undefined,
    streamId: e.streamId,
    debug: { ...emptyDebug(), startedAt: now }
  })
  set((state) => ({ streamOwners: { ...state.streamOwners, [e.streamId]: owner } }))
}

// Design-review convenience: when running in the browser preview (no Electron
// bridge), expose the store so navigation can be driven from the console.
if (typeof window !== 'undefined' && !window.cubex) {
  ;(window as unknown as { __store: typeof useStore }).__store = useStore
}

/** Merge a tool-activity update into the latest assistant message. */
function applyToolEvent(set: SetFn, tool: ToolActivity): void {
  set((s) => {
    const msgs = [...s.liveMessages]
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]!.role === 'assistant') {
        const message = msgs[i]!
        const existing = message.toolCalls ?? []
        const idx = existing.findIndex((t) => t.id === tool.id)
        // A late start cannot overwrite a recorded result, even with an older
        // fixture/bridge that supplies no event sequence; a queued placeholder
        // never demotes a call that already started.
        const prior = idx >= 0 ? existing[idx]!.phase : undefined
        if (tool.phase === 'queued' && prior) return {}
        if (tool.phase === 'running' && (prior === 'done' || prior === 'error')) return {}
        const next = idx >= 0 ? existing.map((t, j) => (j === idx ? { ...t, ...tool } : t)) : [...existing, tool]
        const settled = idx < 0 ? finishReasoning(message) : message
        const blocks = messageDisplayBlocks(settled)
        const blockIndex = blocks.findIndex((block) => block.type === 'tool' && block.tool.id === tool.id)
        if (blockIndex >= 0) blocks[blockIndex] = { type: 'tool', tool: next[idx < 0 ? next.length - 1 : idx]! }
        else blocks.push({ type: 'tool', tool: next[idx < 0 ? next.length - 1 : idx]! })
        msgs[i] = { ...settled, toolCalls: next, blocks, preparingTools: undefined }
        break
      }
    }
    const running = [...msgs].reverse().find((message) => message.role === 'assistant')?.toolCalls?.find((item) => item.phase === 'running')
    const activity: HarnessState = running && ['write_file', 'edit_file'].includes(running.name) ? 'editing'
      : running && ['remove_file', 'delete_file'].includes(running.name) ? 'removing'
      : running && ['exit_plan_mode', 'read_plan'].includes(running.name) ? 'planning' : 'running_tool'
    return {
      liveMessages: msgs,
      status: s.pendingPlan || s.pendingQuestion || s.pendingPermission ? 'awaiting_input'
        : running ? activity
        : s.streamId ? (s.permissionMode === 'plan' ? 'planning' : 'working') : s.status,
      statusDetail: s.pendingPlan || s.pendingQuestion || s.pendingPermission ? s.statusDetail : running?.title
    }
  })
}

/** A turn is starting or running: history must not be rewritten under it. */
function turnBusy(state: CubexState): boolean {
  return !!state.streamId || state.startingRequest || state.liveMessages.some((message) => message.streaming)
}

type SetFn = (partial: Partial<CubexState> | ((s: CubexState) => Partial<CubexState>)) => void
type GetFn = () => CubexState

function updateAssistant(set: SetFn, fn: (m: LiveMessage) => LiveMessage): void {
  set((s) => {
    const msgs = [...s.liveMessages]
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]!.role === 'assistant') {
        msgs[i] = fn(msgs[i]!)
        break
      }
    }
    return { liveMessages: msgs }
  })
}

function settleMessageActivity(message: LiveMessage): LiveMessage {
  message = finishReasoning(message)
  const settle = (tool: ToolActivity): ToolActivity => tool.phase === 'running'
    ? { ...tool, phase: 'error', interrupted: true, detail: `Interrupted: completion was not recorded.${tool.detail ? `\n${tool.detail}` : ''}` }
    : tool.phase === 'queued'
      ? { ...tool, phase: 'error', interrupted: true, detail: 'Not executed: the turn ended before this call ran.' }
      : tool
  return {
    ...message,
    streaming: false,
    preparingTools: undefined,
    ...(message.toolCalls ? { toolCalls: message.toolCalls.map(settle) } : {}),
    ...(message.blocks ? { blocks: message.blocks.map((block) => block.type === 'tool' ? { ...block, tool: settle(block.tool) } : block) } : {})
  }
}

/** Seal each reasoning span when the model moves on; duration belongs to it. */
function finishReasoning(message: LiveMessage): LiveMessage {
  if (message.reasoningStart === undefined) return message
  const elapsed = Math.max(0, Date.now() - message.reasoningStart)
  const blocks = messageDisplayBlocks(message)
  let index = blocks.length - 1
  while (index >= 0 && blocks[index]?.type !== 'reasoning') index--
  const block = blocks[index]
  if (block?.type === 'reasoning') blocks[index] = { ...block, durationMs: (block.durationMs ?? 0) + elapsed }
  return { ...message, blocks, reasoningStart: undefined, reasoningMs: (message.reasoningMs ?? 0) + elapsed }
}

function appendAssistantDelta(message: LiveMessage, type: 'text' | 'reasoning', text: string): LiveMessage {
  if (!text) return message
  const current = type === 'text' ? finishReasoning(message) : message
  const blocks = messageDisplayBlocks(current)
  const boundary = type === 'text' ? current.nextTextBlock : current.nextReasoningBlock
  const previous = blocks.at(-1)
  if (!boundary && previous?.type === type) blocks[blocks.length - 1] = { ...previous, text: previous.text + text }
  else blocks.push({ type, text })
  const canonical = type === 'text' ? current.text : current.reasoning ?? ''
  const joined = canonical + (boundary && canonical ? '\n\n' : '') + text
  return type === 'text'
    ? { ...current, blocks, text: joined, nextTextBlock: false }
    : { ...current, blocks, reasoning: joined, nextReasoningBlock: false, reasoningStart: current.reasoningStart ?? Date.now() }
}

function preparationLabel(name: string | undefined): string {
  if (name === 'exit_plan_mode') return 'Preparing plan'
  if (name === 'write_file' || name === 'edit_file') return 'Preparing edit'
  if (name === 'remove_file' || name === 'delete_file') return 'Preparing removal'
  if (name === 'run_command') return 'Preparing command'
  if (name === 'ask_user_question') return 'Preparing question'
  if (name === 'web_search' || name === 'search_files') return 'Preparing search'
  return 'Preparing tool'
}

function applyStreamEvent(set: SetFn, get: GetFn, ev: AIStreamEvent): void {
  const dbg = get().debug
  switch (ev.type) {
    case 'start':
      updateAssistant(set, (message) => ({ ...finishReasoning(message), preparingTools: undefined }))
      set({
        status: get().pendingPlan || get().pendingQuestion || get().pendingPermission ? 'awaiting_input'
          : get().permissionMode === 'plan' ? 'planning' : 'working',
        statusDetail: undefined,
        debug: { ...dbg, requestId: ev.requestId, provider: ev.provider, model: ev.model, events: [...dbg.events, 'start'] }
      })
      break
    case 'reasoning_delta':
      if (!ev.text) break
      if (!get().pendingPlan && !get().pendingQuestion && !get().pendingPermission) {
        set({ status: get().permissionMode === 'plan' ? 'planning' : 'thinking', statusDetail: undefined })
      }
      updateAssistant(set, (m) => appendAssistantDelta(m, 'reasoning', ev.text))
      break
    case 'text_delta':
      if (!ev.text) break
      if (!get().pendingPlan && !get().pendingQuestion && !get().pendingPermission) {
        set({ status: 'streaming', statusDetail: undefined })
      }
      updateAssistant(set, (m) => appendAssistantDelta(m, 'text', ev.text))
      break
    case 'tool_call_delta': {
      // Providers can spend a long time streaming a plan or edit as JSON before
      // a complete tool call exists. Show preparation without claiming execution.
      if (!Number.isSafeInteger(ev.index) || ev.index < 0 || ev.index >= 64) break
      updateAssistant(set, (message) => {
        const preparingTools = [...(message.preparingTools ?? [])]
        const index = preparingTools.findIndex((tool) => tool.index === ev.index)
        const previous = preparingTools[index]
        const tool = { index: ev.index, name: ev.name?.slice(0, 160) || previous?.name }
        if (index < 0) preparingTools.push(tool)
        else preparingTools[index] = tool
        return { ...finishReasoning(message), preparingTools }
      })
      const name = get().liveMessages.at(-1)?.preparingTools?.find((tool) => tool.index === ev.index)?.name
      if (!get().pendingPlan && !get().pendingQuestion && !get().pendingPermission) {
        set({ status: 'preparing_tool', statusDetail: preparationLabel(name) })
      }
      break
    }
    case 'tool_call':
      // Reserve its chronological place as soon as the normalized call arrives.
      // It is only `queued` until permission gating/execution emits `running`.
      applyToolEvent(set, { id: ev.toolCall.id, name: ev.toolCall.name, phase: 'queued' })
      set({ debug: { ...dbg, events: [...dbg.events, `tool_call:${ev.toolCall.name}`] } })
      break
    case 'usage':
      set({ debug: { ...get().debug, usage: ev.usage } })
      break
    case 'completed':
      set({
        status: ev.response.stopReason === 'cancelled' ? 'cancelled' : 'done',
        statusDetail: undefined,
        debug: {
          ...get().debug,
          usage: ev.response.usage ?? get().debug.usage,
          ttftMs: ev.response.timings?.ttftMs,
          totalMs: ev.response.timings?.totalMs,
          status: ev.response.stopReason,
          events: [...get().debug.events, 'completed']
        }
      })
      updateAssistant(set, (m) => ({
        ...settleMessageActivity(m),
        usage: ev.response.usage
      }))
      persistSettledConversation(get)
      break
    case 'error':
      // A cancel surfaces through the gateway as a CANCELLED error event. That
      // is the user pressing Stop, not a failure; settle the message quietly
      // instead of flashing a red error banner.
      if (ev.error.category === 'CANCELLED') {
        set({
          status: 'cancelled',
          statusDetail: undefined,
          debug: { ...get().debug, status: 'cancelled', events: [...get().debug.events, 'cancelled'] }
        })
        updateAssistant(set, settleMessageActivity)
        persistSettledConversation(get)
        break
      }
      set({
        status: 'error',
        statusDetail: undefined,
        debug: {
          ...get().debug,
          error: ev.error,
          status: 'error',
          events: [...get().debug.events, `error:${ev.error.category}`]
        }
      })
      updateAssistant(set, (m) => ({ ...settleMessageActivity(m), error: ev.error }))
      persistSettledConversation(get)
      break
    case 'stop':
    case 'metadata':
      break
  }
}

function applyGatewayEvent(set: SetFn, get: GetFn, ev: GatewayEvent): void {
  const dbg = get().debug
  switch (ev.type) {
    case 'attempt_start':
      set({
        debug: {
          ...dbg,
          gatewayTrail: [...dbg.gatewayTrail, `attempt ${ev.attempt} → ${ev.target.providerId}/${ev.target.model}`]
        }
      })
      break
    case 'attempt_error':
      set({
        ...(ev.willRetry ? { status: 'retrying' as HarnessState } : {}),
        debug: {
          ...dbg,
          retryCount: ev.willRetry ? dbg.retryCount + 1 : dbg.retryCount,
          gatewayTrail: [
            ...dbg.gatewayTrail,
            `✕ attempt ${ev.attempt}: ${ev.error.category}${ev.willRetry ? ` (retry in ${ev.delayMs}ms)` : ''}`
          ]
        }
      })
      break
    case 'retry_wait':
      set({ status: 'retrying', statusDetail: `attempt ${ev.attempt + 1} in ${Math.round(ev.delayMs)}ms` })
      break
    case 'fallback':
      set({
        status: 'falling_back',
        statusDetail: ev.to.providerId,
        debug: {
          ...dbg,
          gatewayTrail: [...dbg.gatewayTrail, `↳ fallback → ${ev.to.providerId}/${ev.to.model} (${ev.reason})`]
        }
      })
      break
    case 'final':
      set({
        debug: {
          ...dbg,
          gatewayTrail: [
            ...dbg.gatewayTrail,
            `final: ${ev.target.providerId}/${ev.target.model} ${ev.success ? 'ok' : 'failed'}`
          ]
        }
      })
      break
  }
}

async function persistConversation(get: GetFn): Promise<void> {
  const { activeConversation, liveMessages } = get()
  if (!activeConversation) return
  const messages: StoredMessage[] = liveMessages.map((m) => ({
    id: m.id,
    role: m.role,
    text: m.text,
    createdAt: m.createdAt,
    // Persist image/file attachments as content parts so they survive reload
    // and stay in the model's history on later turns.
    ...(m.attachments?.length
      ? { contentJson: JSON.stringify([{ type: 'text', text: m.text }, ...m.attachments]) }
      : m.contentJson ? { contentJson: m.contentJson } : {}),
    ...(m.toolCallsJson ? { toolCallsJson: m.toolCallsJson } : {}),
    uiTranscriptJson: serializeMessageTranscript(m),
    ...(m.usage ? { usage: m.usage } : {}),
    ...(m.error ? { error: m.error } : {})
  }))
  let title = activeConversation.title
  if (title === 'New Chat' || title === 'New conversation') {
    const firstUser = liveMessages.find((m) => m.role === 'user')
    if (firstUser) title = firstUser.text.slice(0, 44).trim()
  }
  await api.updateConversation(activeConversation.id, { messages, title })
  useStore.setState((s) => ({
    tabs: s.tabs.map((t) => (t.id === activeConversation.id ? { ...t, title } : t)),
    activeConversation: s.activeConversation?.id === activeConversation.id ? { ...s.activeConversation, title } : s.activeConversation,
    conversationRuns: s.conversationRuns[activeConversation.id] ? {
      ...s.conversationRuns,
      [activeConversation.id]: { ...s.conversationRuns[activeConversation.id]!, activeConversation: { ...activeConversation, title } }
    } : s.conversationRuns
  }))
  await get().loadConversations()
}

/** Terminal events must remain settled even if a history write is unavailable. */
function persistSettledConversation(get: GetFn): void {
  const owner = get().activeConversation?.id
  void persistConversation(get).catch(() => {
    if (!owner) return
    const [updateOwner] = conversationAccess(useStore.setState, useStore.getState, owner)
    updateOwner((state) => ({ debug: { ...state.debug, events: [...state.debug.events, 'history_save_failed'] } }))
  })
}
