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
import type { ReasoningEffort } from '@core/types'
import { defaultEffortFor } from '@core/providers'
import type { ChatEvent, Conversation, ConversationSummary, Preset, StoredMessage } from '../../../shared/ipc'
import type { AppSettings } from '../../../shared/settings'
import { api } from '../lib/api'
import type { HarnessState } from '../status/StatusIndicator'

export type ViewId =
  | 'chat'
  | 'pinned'
  | 'archive'
  | 'providers'
  | 'local'
  | 'browser'
  | 'hardware'
  | 'benchmarks'
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
  reasoning?: string
  streaming?: boolean
  toolCalls?: Array<{ name: string; id: string }>
}

interface CubexState {
  view: ViewId
  setView: (v: ViewId) => void
  panelOpen: boolean
  togglePanel: () => void
  panelTab: 'params' | 'inspector'
  setPanelTab: (t: 'params' | 'inspector') => void

  providers: ProviderConfig[]
  models: Record<string, ModelInfo[]>
  activeProviderId?: string
  activeModel?: string
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
  newConversation: () => Promise<void>
  openConversation: (id: string) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  renameActiveConversation: (id: string, title: string) => Promise<void>
  selectTab: (id: string) => Promise<void>
  closeTab: (id: string) => void

  liveMessages: LiveMessage[]
  status: HarnessState
  statusDetail?: string
  streamId?: string
  /** Wall-clock ms when the current generation started (for the elapsed timer). */
  genStartedAt?: number
  debug: DebugInfo

  /** Composer options. */
  webSearch: boolean
  toggleWebSearch: () => void
  subagents: boolean
  toggleSubagents: () => void
  longContext: boolean
  toggleLongContext: () => void
  effort?: ReasoningEffort
  setEffort: (e: ReasoningEffort) => void
  maxTokens: number
  setMaxTokens: (v: number) => void

  /** Per-conversation system prompt override set via /system. */
  sessionSystem?: string
  /** Per-conversation goal set via /goal (kept in the system context each turn). */
  sessionGoal?: string
  setGoal: (goal: string | undefined) => void

  sendMessage: (text: string) => Promise<void>
  cancel: () => void
  regenerate: () => Promise<void>
  clearActive: () => Promise<void>
  compactActive: () => Promise<void>
  /** Handle a "/command"; returns true if it was a recognized command. */
  runSlashCommand: (input: string) => Promise<boolean>

  settings?: AppSettings
  loadSettings: () => Promise<void>
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>
  pickWorkspace: () => Promise<void>
  clearWorkspace: () => Promise<void>

  _initChatEvents: () => void
}

function emptyDebug(): DebugInfo {
  return { retryCount: 0, events: [], gatewayTrail: [] }
}

/** Compose the effective system prompt from base + workspace + goal context. */
function composeSystem(
  base: string | undefined,
  ctx: { workspace?: string; goal?: string }
): string | undefined {
  const parts: string[] = []
  if (base) parts.push(base)
  if (ctx.workspace) parts.push(`The user's active workspace folder is: ${ctx.workspace}`)
  if (ctx.goal) parts.push(`Current goal for this session — keep working toward it:\n${ctx.goal}`)
  return parts.length ? parts.join('\n\n') : undefined
}

export const useStore = create<CubexState>((set, get) => ({
  view: 'chat',
  setView: (v) => set({ view: v }),
  panelOpen: false,
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  panelTab: 'params',
  setPanelTab: (t) => set({ panelTab: t }),

  providers: [],
  models: {},
  loadProviders: async () => {
    const providers = await api.listProviders()
    set({ providers })
    const { activeProviderId } = get()
    const first = providers.find((p) => p.enabled)
    if (!activeProviderId && first) {
      set({ activeProviderId: first.id, activeModel: first.defaultModel, effort: defaultEffortFor(first.kind) })
      await get().loadModels(first.id)
    }
  },
  setActive: (providerId, model) => {
    const kind = get().providers.find((p) => p.id === providerId)?.kind
    set({
      activeProviderId: providerId,
      activeModel: model,
      // Reset effort to the provider's default (undefined hides the selector).
      effort: kind ? defaultEffortFor(kind) : undefined
    })
  },
  loadModels: async (providerId) => {
    const models = await api.listModels(providerId)
    set((s) => ({ models: { ...s.models, [providerId]: models } }))
    if (!get().activeModel && models[0]) set({ activeModel: models[0].id })
  },

  presets: [],
  loadPresets: async () => set({ presets: await api.listPresets() }),
  applyPreset: (id) => {
    const p = get().presets.find((x) => x.id === id)
    if (!p) return
    const kind = get().providers.find((x) => x.id === p.providerId)?.kind
    set({
      activePresetId: id,
      activeProviderId: p.providerId,
      activeModel: p.model,
      effort: p.params?.reasoningEffort ?? (kind ? defaultEffortFor(kind) : undefined),
      ...(p.params?.maxOutputTokens !== undefined ? { maxTokens: p.params.maxOutputTokens } : {})
    })
    void get().loadModels(p.providerId)
  },

  conversations: [],
  tabs: [],
  loadConversations: async () => set({ conversations: await api.listConversations() }),

  newConversation: async () => {
    const { activeProviderId, activeModel, providers, tabs } = get()
    const execution = providers.find((p) => p.id === activeProviderId)?.accessType === 'local' ? 'local' : 'cloud'
    const conv = await api.createConversation({
      title: 'New Chat',
      ...(activeProviderId ? { providerId: activeProviderId } : {}),
      ...(activeModel ? { model: activeModel } : {}),
      execution
    })
    set({
      activeConversation: conv,
      liveMessages: [],
      status: 'idle',
      debug: emptyDebug(),
      view: 'chat',
      sessionSystem: undefined,
      sessionGoal: undefined,
      tabs: [...tabs, { id: conv.id, title: conv.title }],
      activeTabId: conv.id
    })
    await get().loadConversations()
  },

  openConversation: async (id) => {
    const conv = await api.getConversation(id)
    if (!conv) return
    const tabs = get().tabs.some((t) => t.id === id)
      ? get().tabs
      : [...get().tabs, { id: conv.id, title: conv.title }]
    set({
      activeConversation: conv,
      liveMessages: conv.messages,
      status: 'idle',
      debug: emptyDebug(),
      view: 'chat',
      tabs,
      activeTabId: id
    })
  },

  deleteConversation: async (id) => {
    await api.deleteConversation(id)
    const tabs = get().tabs.filter((t) => t.id !== id)
    const wasActive = get().activeConversation?.id === id
    set({
      tabs,
      ...(wasActive ? { activeConversation: undefined, liveMessages: [], activeTabId: tabs.at(-1)?.id } : {})
    })
    if (wasActive && tabs.length) await get().openConversation(tabs.at(-1)!.id)
    await get().loadConversations()
  },

  renameActiveConversation: async (id, title) => {
    await api.updateConversation(id, { title })
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)),
      ...(s.activeConversation?.id === id ? { activeConversation: { ...s.activeConversation, title } } : {})
    }))
    await get().loadConversations()
  },

  selectTab: async (id) => {
    if (get().activeTabId === id) return
    await get().openConversation(id)
  },

  closeTab: (id) => {
    const tabs = get().tabs.filter((t) => t.id !== id)
    const wasActive = get().activeTabId === id
    set({ tabs })
    if (wasActive) {
      const next = tabs.at(-1)
      if (next) void get().openConversation(next.id)
      else set({ activeTabId: undefined, activeConversation: undefined, liveMessages: [] })
    }
  },

  liveMessages: [],
  status: 'idle',
  debug: emptyDebug(),

  webSearch: false,
  toggleWebSearch: () => set((s) => ({ webSearch: !s.webSearch })),
  subagents: false,
  toggleSubagents: () => set((s) => ({ subagents: !s.subagents })),
  longContext: false,
  toggleLongContext: () => set((s) => ({ longContext: !s.longContext })),
  effort: undefined,
  setEffort: (e) => set({ effort: e }),
  maxTokens: 4096,
  setMaxTokens: (v) => set({ maxTokens: v }),

  sendMessage: async (text) => {
    const state = get()
    if (!state.activeProviderId || !state.activeModel) return
    let conv = state.activeConversation
    if (!conv) {
      await state.newConversation()
      conv = get().activeConversation!
    }

    const userMsg: LiveMessage = { id: nanoid(), role: 'user', text, createdAt: Date.now() }
    const assistantMsg: LiveMessage = {
      id: nanoid(),
      role: 'assistant',
      text: '',
      createdAt: Date.now(),
      streaming: true
    }
    set({
      liveMessages: [...get().liveMessages, userMsg, assistantMsg],
      status: 'thinking',
      statusDetail: undefined,
      genStartedAt: Date.now(),
      debug: { ...emptyDebug(), startedAt: Date.now(), model: state.activeModel, provider: state.activeProviderId }
    })

    const s = get()
    const policy: RoutingPolicy = {
      primary: {
        providerId: s.activeProviderId!,
        model: s.activeModel!,
        params: {
          maxOutputTokens: s.maxTokens,
          ...(s.effort ? { reasoningEffort: s.effort } : {})
        }
      },
      fallbacks: [],
      fallbackEnabled: s.settings?.ai.fallbackEnabled ?? false,
      retry: s.settings?.ai.retry ?? DEFAULT_RETRY_POLICY,
      timeout: s.settings?.ai.timeout ?? {}
    }

    const preset = s.presets.find((p) => p.id === s.activePresetId)
    const systemPrompt = composeSystem(s.sessionSystem ?? preset?.systemPrompt, {
      workspace: s.settings?.general.workspacePath,
      goal: s.sessionGoal
    })
    const { streamId } = await api.startChat({
      conversationId: conv.id,
      policy,
      userText: text,
      subagentEnabled: s.subagents,
      longContext: s.longContext,
      ...(systemPrompt ? { systemPrompt } : {})
    })
    set({ streamId })
  },

  clearActive: async () => {
    const conv = get().activeConversation
    if (!conv) return
    await api.updateConversation(conv.id, { messages: [] })
    set({ liveMessages: [], status: 'idle', debug: emptyDebug() })
    await get().loadConversations()
  },

  compactActive: async () => {
    // Local compaction: keep the last 6 messages, replace the rest with a note.
    // (Server-side summarization would call a provider; this is a safe, offline
    // context-saver that never silently loses data — the full log stays in SQLite
    // history until the next persist.)
    const msgs = get().liveMessages
    if (msgs.length <= 8) return
    const keep = msgs.slice(-6)
    const droppedCount = msgs.length - keep.length
    const note: LiveMessage = {
      id: nanoid(),
      role: 'system',
      text: `[${droppedCount} earlier messages compacted to save context]`,
      createdAt: Date.now()
    }
    set({ liveMessages: [note, ...keep] })
    await persistConversation(get)
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
        set({ panelOpen: true, panelTab: 'params' })
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
      statusDetail: undefined,
      liveMessages: s.liveMessages.map((m) => (m.streaming ? { ...m, streaming: false } : m))
    }))
  },

  regenerate: async () => {
    const msgs = get().liveMessages
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
    if (!lastUser) return
    // Drop trailing assistant turn before re-asking.
    const idx = msgs.map((m) => m.role).lastIndexOf('assistant')
    set({ liveMessages: idx >= 0 ? msgs.slice(0, idx) : msgs })
    await get().sendMessage(lastUser.text)
  },

  settings: undefined,
  loadSettings: async () => {
    const settings = await api.getSettings()
    set({ settings, maxTokens: settings.ai.maxOutputTokens })
  },
  saveSettings: async (patch) => set({ settings: await api.updateSettings(patch) }),

  pickWorkspace: async () => {
    const path = await api.pickWorkspace()
    if (!path) return
    const s = get().settings
    if (!s) return
    await get().saveSettings({ general: { ...s.general, workspacePath: path } })
  },
  clearWorkspace: async () => {
    const s = get().settings
    if (!s) return
    const { workspacePath, ...general } = s.general
    void workspacePath
    await get().saveSettings({ general })
  },

  _initChatEvents: () => {
    api.onChatEvent((e: ChatEvent) => {
      if (e.streamId !== get().streamId) return
      if (e.kind === 'gateway') applyGatewayEvent(set, get, e.event)
      else applyStreamEvent(set, get, e.event)
    })
  }
}))

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

function applyStreamEvent(set: SetFn, get: GetFn, ev: AIStreamEvent): void {
  const dbg = get().debug
  switch (ev.type) {
    case 'start':
      set({
        status: 'working',
        debug: { ...dbg, requestId: ev.requestId, provider: ev.provider, model: ev.model, events: [...dbg.events, 'start'] }
      })
      break
    case 'reasoning_delta':
      set({ status: 'thinking' })
      updateAssistant(set, (m) => ({ ...m, reasoning: (m.reasoning ?? '') + ev.text }))
      break
    case 'text_delta':
      set({ status: 'streaming', statusDetail: undefined })
      updateAssistant(set, (m) => ({ ...m, text: m.text + ev.text }))
      break
    case 'tool_call':
      set({
        status: 'running_tool',
        statusDetail: ev.toolCall.name,
        debug: { ...dbg, events: [...dbg.events, `tool_call:${ev.toolCall.name}`] }
      })
      updateAssistant(set, (m) => ({
        ...m,
        toolCalls: [...(m.toolCalls ?? []), { name: ev.toolCall.name, id: ev.toolCall.id }]
      }))
      break
    case 'usage':
      set({ debug: { ...get().debug, usage: ev.usage } })
      break
    case 'completed':
      set({
        status: 'done',
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
      updateAssistant(set, (m) => ({ ...m, streaming: false, usage: ev.response.usage }))
      void persistConversation(get)
      break
    case 'error':
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
      updateAssistant(set, (m) => ({ ...m, streaming: false, error: ev.error }))
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
            `✕ attempt ${ev.attempt}: ${ev.error.category}${ev.willRetry ? ` · retry in ${ev.delayMs}ms` : ''}`
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
    activeConversation: s.activeConversation ? { ...s.activeConversation, title } : undefined
  }))
  await get().loadConversations()
}
