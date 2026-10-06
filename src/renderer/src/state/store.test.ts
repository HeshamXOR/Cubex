import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent, ChatStartRequest, Conversation, ContextUsageSnapshot, PlanAsk, StoredMessage } from '../../../shared/ipc'
import { serializeMessageTranscript } from '../../../shared/messageTranscript'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../shared/settings'
import { NormalizedAIError, type ModelInfo, type ProviderConfig, type ProviderKind } from '@core/types'

const bridge = vi.hoisted(() => ({
  listeners: new Set<(event: ChatEvent) => void>(),
  api: {
    startChat: vi.fn(), resolvePlan: vi.fn(), listPlans: vi.fn(),
    getConversation: vi.fn(), listConversations: vi.fn(), updateConversation: vi.fn(),
    cancelChat: vi.fn(), onChatEvent: vi.fn(), createConversation: vi.fn(), updateSettings: vi.fn(), compactConversation: vi.fn(),
    listModels: vi.fn(), listProviders: vi.fn(), getSettings: vi.fn()
  }
}))
vi.mock('../lib/api', () => ({ api: bridge.api }))
import { COMPOSER_MAX_LENGTH, useStore } from './store'

const conversation = (id: string): Conversation => ({
  id, title: `Task ${id}`, createdAt: 1, updatedAt: 1, execution: 'cloud',
  workspacePath: `I:\\${id}`, messages: []
})
const plan = (id = 'plan-a', owner = 'a'): PlanAsk => ({
  id, conversationId: owner, title: 'Implementation', plan: '# Implementation\n\n1. Read the module.\n2. Update it.',
  path: `I:\\plans\\${id}.md`, createdAt: 10, status: 'pending'
})
const emit = (event: ChatEvent) => { for (const listener of bridge.listeners) listener(event) }

beforeEach(() => {
  vi.clearAllMocks()
  bridge.listeners.clear()
  bridge.api.onChatEvent.mockImplementation((callback: (event: ChatEvent) => void) => {
    bridge.listeners.add(callback)
    return () => bridge.listeners.delete(callback)
  })
  bridge.api.startChat.mockImplementation(async (request: ChatStartRequest) => ({ streamId: request.streamId }))
  bridge.api.resolvePlan.mockResolvedValue(undefined)
  bridge.api.listPlans.mockResolvedValue([])
  bridge.api.getConversation.mockImplementation(async (id: string) => conversation(id))
  bridge.api.listConversations.mockResolvedValue([])
  bridge.api.updateConversation.mockResolvedValue(undefined)
  bridge.api.cancelChat.mockResolvedValue(undefined)
  bridge.api.compactConversation.mockResolvedValue({ ok: true, summary: 'Goal: ship the retry fix.', boundaryMessageId: 'm4' })
  bridge.api.listModels.mockResolvedValue([])
  bridge.api.listProviders.mockResolvedValue([])
  bridge.api.getSettings.mockResolvedValue(DEFAULT_SETTINGS)
  bridge.api.createConversation.mockImplementation(async (partial: Partial<Conversation>) => ({ ...conversation('new'), workspacePath: undefined, ...partial }))
  bridge.api.updateSettings.mockImplementation(async (patch: Partial<AppSettings>) => ({
    ...useStore.getState().settings, ...patch,
    general: { ...useStore.getState().settings?.general, ...patch.general }
  }))
  useStore.setState(useStore.getInitialState(), true)
  useStore.setState({ activeConversation: conversation('a'), activeTabId: 'a', activeProviderId: 'mock', activeModel: 'mock-1', permissionMode: 'plan' })
  useStore.getState()._initChatEvents()
})

describe('plan review and task stream ownership', () => {
  it('receives a plan that arrives before startChat resolves', async () => {
    bridge.api.startChat.mockImplementation(async (request: ChatStartRequest) => {
      emit({ streamId: request.streamId!, kind: 'plan', ask: plan() })
      return { streamId: request.streamId }
    })
    await useStore.getState().sendMessage('Plan this change')
    expect(useStore.getState().pendingPlan?.id).toBe('plan-a')
    expect(useStore.getState().planPanelOpen).toBe(true)
    expect(useStore.getState().status).toBe('awaiting_input')
  })

  it('closing the document leaves the approval pending', () => {
    useStore.setState({ pendingPlan: plan() })
    useStore.getState().openPlan(plan())
    useStore.getState().closePlan()
    expect(useStore.getState().pendingPlan?.id).toBe('plan-a')
    expect(bridge.api.resolvePlan).not.toHaveBeenCalled()
  })

  it('returns rejection feedback and keeps planning without losing the saved document', async () => {
    useStore.setState({ pendingPlan: plan(), activePlan: plan(), plans: [plan()] })
    await useStore.getState().resolvePlan('plan-a', 'reject', 'Use the existing router; do not add a package.')
    expect(bridge.api.resolvePlan).toHaveBeenCalledWith('plan-a', 'reject', 'Use the existing router; do not add a package.')
    expect(useStore.getState().permissionMode).toBe('plan')
    expect(useStore.getState().pendingPlan).toBeUndefined()
    expect(useStore.getState().activePlan?.status).toBe('rejected')
    expect(useStore.getState().plans[0]?.feedback).toContain('existing router')
  })

  it('retains pending review when the bridge rejects the decision', async () => {
    useStore.setState({ pendingPlan: plan(), activePlan: plan() })
    bridge.api.resolvePlan.mockRejectedValueOnce(new Error('Unable to save review'))
    await expect(useStore.getState().resolvePlan('plan-a', 'default')).rejects.toThrow('Unable to save review')
    expect(useStore.getState().pendingPlan?.id).toBe('plan-a')
    expect(useStore.getState().permissionMode).toBe('plan')
  })

  it('does not clear a revised plan arriving while rejection resolves', async () => {
    await useStore.getState().sendMessage('Plan this')
    const streamId = useStore.getState().streamId!
    emit({ streamId, kind: 'plan', ask: plan() })
    bridge.api.resolvePlan.mockImplementation(async () => {
      emit({ streamId, kind: 'plan', ask: { ...plan('plan-b'), createdAt: 20 } })
    })
    await useStore.getState().resolvePlan('plan-a', 'reject', 'Add validation')
    expect(useStore.getState().pendingPlan?.id).toBe('plan-b')
    expect(useStore.getState().activePlan?.id).toBe('plan-b')
    expect(useStore.getState().plans).toHaveLength(2)
  })

  it('keeps background text and approvals with the originating task', async () => {
    await useStore.getState().sendMessage('Plan task A')
    const streamId = useStore.getState().streamId!
    await useStore.getState().openConversation('b')
    emit({ streamId, kind: 'stream', event: { type: 'text_delta', text: 'Research for A' } })
    emit({ streamId, kind: 'plan', ask: plan() })
    expect(useStore.getState().activeConversation?.id).toBe('b')
    expect(useStore.getState().liveMessages).toEqual([])
    expect(useStore.getState().pendingPlan).toBeUndefined()
    expect(useStore.getState().planPanelOpen).toBe(false)
    await useStore.getState().openConversation('a')
    expect(useStore.getState().pendingPlan?.id).toBe('plan-a')
    expect(useStore.getState().liveMessages.at(-1)?.text).toBe('Research for A')
    expect(useStore.getState().plans[0]?.id).toBe('plan-a')
  })

  it('persists a background completion without renaming or replacing the visible task', async () => {
    await useStore.getState().sendMessage('Work on task A')
    const streamId = useStore.getState().streamId!
    await useStore.getState().openConversation('b')
    emit({ streamId, kind: 'stream', event: { type: 'text_delta', text: 'Task A result' } })
    emit({ streamId, kind: 'stream', event: { type: 'completed', response: {
      id: 'reply', provider: 'mock', model: 'mock-1', text: 'Task A result',
      content: [{ type: 'text', text: 'Task A result' }], toolCalls: [], stopReason: 'stop', createdAt: 2
    } } })
    await vi.waitFor(() => expect(bridge.api.updateConversation).toHaveBeenCalled())
    expect(bridge.api.updateConversation.mock.calls[0]?.[0]).toBe('a')
    expect(useStore.getState().activeConversation?.title).toBe('Task b')
    expect(useStore.getState().liveMessages).toEqual([])
  })

  it('ignores a delayed history response after switching tasks', async () => {
    let complete!: (plans: PlanAsk[]) => void
    bridge.api.listPlans.mockImplementationOnce(() => new Promise<PlanAsk[]>((resolve) => { complete = resolve }))
    const loading = useStore.getState().loadPlans('a')
    await useStore.getState().openConversation('b')
    complete([plan()])
    await loading
    expect(useStore.getState().plans).toEqual([])
    expect(useStore.getState().activePlan).toBeUndefined()
  })

  it('does not replace a resolved review with a stale pending history response', async () => {
    useStore.setState({ pendingPlan: plan(), activePlan: plan(), plans: [plan()] })
    let complete!: (plans: PlanAsk[]) => void
    bridge.api.listPlans.mockImplementationOnce(() => new Promise<PlanAsk[]>((resolve) => { complete = resolve }))
    const loading = useStore.getState().loadPlans('a')
    await useStore.getState().resolvePlan('plan-a', 'reject', 'Try a smaller change')
    complete([plan()])
    await loading
    expect(useStore.getState().activePlan?.status).toBe('rejected')
    expect(useStore.getState().plans[0]?.feedback).toBe('Try a smaller change')
  })

  it('keeps one stream subscription across React strict-mode initialization', () => {
    useStore.getState()._initChatEvents()
    useStore.getState()._initChatEvents()
    expect(bridge.listeners.size).toBe(1)
  })

  it('captures a plan arriving while navigation is waiting on disk', async () => {
    await useStore.getState().sendMessage('Plan task A')
    const streamId = useStore.getState().streamId!
    let finishNavigation!: (value: Conversation) => void
    bridge.api.getConversation.mockImplementationOnce(() => new Promise<Conversation>((resolve) => { finishNavigation = resolve }))
    const navigation = useStore.getState().openConversation('b')
    emit({ streamId, kind: 'plan', ask: plan() })
    finishNavigation(conversation('b'))
    await navigation
    await useStore.getState().openConversation('a')
    expect(useStore.getState().pendingPlan?.id).toBe('plan-a')
    expect(useStore.getState().planPanelOpen).toBe(true)
  })

  it('does not reopen an older navigation when its read completes late', async () => {
    let finishNavigation!: (value: Conversation) => void
    bridge.api.getConversation.mockImplementationOnce(() => new Promise<Conversation>((resolve) => { finishNavigation = resolve }))
    const navigation = useStore.getState().openConversation('b')
    await useStore.getState().openConversation('c')
    finishNavigation(conversation('b'))
    await navigation
    expect(useStore.getState().activeConversation?.id).toBe('c')
  })

  it('does not resume a finished turn when approval acknowledgment arrives late', async () => {
    await useStore.getState().sendMessage('Plan this')
    const streamId = useStore.getState().streamId!
    emit({ streamId, kind: 'plan', ask: plan() })
    bridge.api.resolvePlan.mockImplementation(async () => {
      emit({ streamId, kind: 'stream', event: { type: 'completed', response: {
        id: 'reply', provider: 'mock', model: 'mock-1', text: 'Done', content: [], toolCalls: [], stopReason: 'stop', createdAt: 2
      } } })
    })
    await useStore.getState().resolvePlan('plan-a', 'default')
    expect(useStore.getState().status).toBe('done')
    expect(useStore.getState().pendingPlan).toBeUndefined()
    expect(useStore.getState().streamId).toBeUndefined()
  })

  it('ignores a queued plan event arriving after Stop', async () => {
    await useStore.getState().sendMessage('Plan this')
    const streamId = useStore.getState().streamId!
    useStore.getState().cancel()
    emit({ streamId, kind: 'plan', ask: plan() })
    expect(useStore.getState().pendingPlan).toBeUndefined()
    expect(useStore.getState().status).toBe('cancelled')
    expect(useStore.getState().planPanelOpen).toBe(false)
  })

  it('keeps the task usable when plan history fails, then lets a retry recover', async () => {
    bridge.api.listPlans.mockRejectedValueOnce(new Error('Disk unavailable'))
    await useStore.getState().openConversation('b')
    expect(useStore.getState().activeConversation?.id).toBe('b')
    expect(useStore.getState().planLoadError).toBe('Saved plans could not be loaded.')
    bridge.api.listPlans.mockResolvedValueOnce([{ ...plan('plan-b', 'b'), status: 'approved' }])
    await useStore.getState().loadPlans('b')
    expect(useStore.getState().plans[0]?.id).toBe('plan-b')
    expect(useStore.getState().planLoadError).toBeUndefined()
  })

  it('settles the saved plan card when the turn fails while awaiting review', async () => {
    await useStore.getState().sendMessage('Plan this')
    const streamId = useStore.getState().streamId!
    emit({ streamId, kind: 'plan', ask: plan() })
    emit({ streamId, kind: 'stream', event: { type: 'error', error: new NormalizedAIError({
      provider: 'mock', category: 'UNKNOWN', message: 'Disconnected', classification: 'permanent', retryable: false
    }) } })
    expect(useStore.getState().pendingPlan).toBeUndefined()
    expect(useStore.getState().activePlan?.status).toBe('cancelled')
    expect(useStore.getState().plans[0]?.status).toBe('cancelled')
  })

  it('does not overwrite a later permission choice when a plan decision resolves', async () => {
    await useStore.getState().sendMessage('Plan this')
    emit({ streamId: useStore.getState().streamId!, kind: 'plan', ask: plan() })
    let finish!: () => void
    bridge.api.resolvePlan.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    const resolving = useStore.getState().resolvePlan('plan-a', 'default')
    useStore.getState().setPermissionMode('acceptEdits')
    finish()
    await resolving
    expect(useStore.getState().permissionMode).toBe('acceptEdits')
  })

  it('does not apply a previous turn approval to a new turn', async () => {
    await useStore.getState().sendMessage('Plan this')
    const streamId = useStore.getState().streamId!
    emit({ streamId, kind: 'plan', ask: plan() })
    let finish!: () => void
    bridge.api.resolvePlan.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    const resolving = useStore.getState().resolvePlan('plan-a', 'bypass')
    emit({ streamId, kind: 'stream', event: { type: 'completed', response: {
      id: 'reply', provider: 'mock', model: 'mock-1', text: 'Done', content: [], toolCalls: [], stopReason: 'stop', createdAt: 2
    } } })
    useStore.getState().setPermissionMode('default')
    await useStore.getState().sendMessage('A new task step')
    finish()
    await resolving
    expect(useStore.getState().permissionMode).toBe('default')
    expect(useStore.getState().status).toBe('thinking')
  })
})

describe('provider selection and model refresh', () => {
  const provider = (id = 'primary', overrides: Partial<ProviderConfig> = {}): ProviderConfig => ({
    id, name: id, kind: 'openai-compat', accessType: 'api', enabled: true, auth: { type: 'none' },
    defaultModel: `${id}-default`, ...overrides
  })
  const model = (id: string, providerId = 'primary'): ModelInfo => ({
    id, providerId, displayName: id, location: 'cloud', capabilities: ['text'],
    modalities: { input: ['text'], output: ['text'] }, supportsTools: true,
    supportsStructuredOutput: false, supportsReasoning: false
  })
  const deferred = <T,>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((finish) => { resolve = finish })
    return { promise, resolve }
  }
  beforeEach(() => {
    useStore.setState({ activeProviderId: undefined, activeModel: undefined, settings: DEFAULT_SETTINGS })
  })

  it('refreshes selected provider metadata after edits while retaining an explicit model', async () => {
    const original = provider()
    useStore.setState({ providers: [original], models: { primary: [model('old-model')] } })
    useStore.getState().setActive('primary', 'manual-model')
    bridge.api.listProviders.mockResolvedValue([{ ...original, baseUrl: 'http://127.0.0.1:9000/v1' }])
    bridge.api.listModels.mockResolvedValue([model('new-model')])
    await useStore.getState().loadProviders()
    expect(bridge.api.listModels).toHaveBeenCalledWith('primary')
    expect(useStore.getState().models.primary?.map((entry) => entry.id)).toEqual(['new-model'])
    expect(useStore.getState().activeModel).toBe('manual-model')
  })

  it.each(['removed', 'disabled'] as const)('clears a %s selection without choosing another provider on later refreshes', async (change) => {
    useStore.setState({ providers: [provider(), provider('other')], models: { primary: [model('old-model')] }, effort: 'high', activePresetId: 'preset' })
    useStore.getState().setActive('primary', 'old-model')
    bridge.api.listProviders.mockResolvedValue(change === 'removed' ? [provider('other')] : [provider('primary', { enabled: false }), provider('other')])
    await useStore.getState().loadProviders()
    await useStore.getState().loadProviders()
    expect(useStore.getState()).toMatchObject({ activeProviderId: undefined, activeModel: undefined, activePresetId: undefined, effort: undefined })
    expect(useStore.getState().models.primary).toBeUndefined()
    expect(bridge.api.listModels).not.toHaveBeenCalled()
  })

  it('ignores a stale provider list after a newer refresh removes the selection', async () => {
    useStore.setState({ providers: [provider()] })
    useStore.getState().setActive('primary', 'old-model')
    const oldList = deferred<ProviderConfig[]>()
    bridge.api.listProviders.mockReturnValueOnce(oldList.promise).mockResolvedValueOnce([])
    const first = useStore.getState().loadProviders()
    await useStore.getState().loadProviders()
    oldList.resolve([provider()])
    await first
    expect(useStore.getState().providers).toEqual([])
    expect(useStore.getState().activeProviderId).toBeUndefined()
  })

  it('discards metadata from an older configuration even when that response finishes last', async () => {
    useStore.setState({ providers: [provider()] })
    useStore.getState().setActive('primary', '')
    const oldModels = deferred<ModelInfo[]>()
    bridge.api.listModels.mockReturnValueOnce(oldModels.promise).mockResolvedValueOnce([model('new-model')])
    const oldRequest = useStore.getState().loadModels('primary')
    bridge.api.listProviders.mockResolvedValue([provider('primary', { baseUrl: 'http://127.0.0.1:9000/v1' })])
    await useStore.getState().loadProviders()
    oldModels.resolve([model('old-model')])
    await oldRequest
    expect(useStore.getState().activeModel).toBe('new-model')
    expect(useStore.getState().models.primary?.map((entry) => entry.id)).toEqual(['new-model'])
  })

  it('keeps the latest catalog when overlapping model refreshes finish out of order', async () => {
    useStore.setState({ providers: [provider()] })
    useStore.getState().setActive('primary', '')
    const oldModels = deferred<ModelInfo[]>()
    bridge.api.listModels.mockReturnValueOnce(oldModels.promise).mockResolvedValueOnce([model('new-model')])
    const first = useStore.getState().loadModels('primary')
    await useStore.getState().loadModels('primary')
    oldModels.resolve([model('old-model')])
    await first
    expect(useStore.getState().activeModel).toBe('new-model')
    expect(useStore.getState().models.primary?.map((entry) => entry.id)).toEqual(['new-model'])
  })

  it('does not resurrect deleted provider metadata when its outstanding request settles', async () => {
    useStore.setState({ providers: [provider()] })
    useStore.getState().setActive('primary', '')
    const pending = deferred<ModelInfo[]>()
    bridge.api.listModels.mockReturnValueOnce(pending.promise)
    const loading = useStore.getState().loadModels('primary')
    bridge.api.listProviders.mockResolvedValue([])
    await useStore.getState().loadProviders()
    pending.resolve([model('deleted-model')])
    await loading
    expect(useStore.getState().models.primary).toBeUndefined()
    expect(useStore.getState().activeProviderId).toBeUndefined()
  })

  it('keeps a provider selected while the provider-list request is pending', async () => {
    useStore.setState({ providers: [provider(), provider('other')] })
    useStore.getState().setActive('primary', 'primary-default')
    const pending = deferred<ProviderConfig[]>()
    bridge.api.listProviders.mockReturnValueOnce(pending.promise)
    const loading = useStore.getState().loadProviders()
    useStore.getState().setActive('other', 'chosen-model')
    pending.resolve([provider(), provider('other')])
    await loading
    expect(useStore.getState().activeProviderId).toBe('other')
    expect(useStore.getState().activeModel).toBe('chosen-model')
    expect(bridge.api.listModels).toHaveBeenCalledWith('other')
  })

  it('does not treat an unavailable model endpoint as a provider-save failure', async () => {
    bridge.api.listProviders.mockResolvedValue([provider()])
    bridge.api.listModels.mockRejectedValueOnce(new Error('Model endpoint unavailable'))
    await expect(useStore.getState().loadProviders()).resolves.toBeUndefined()
    expect(useStore.getState().providers).toHaveLength(1)
    expect(useStore.getState().activeProviderId).toBe('primary')
    expect(useStore.getState().activeModel).toBe('primary-default')
  })

  it('initially selects an eligible local endpoint in Local Only mode', async () => {
    useStore.setState({ settings: { ...DEFAULT_SETTINGS, privacy: { ...DEFAULT_SETTINGS.privacy, localOnly: true } } })
    bridge.api.listProviders.mockResolvedValue([
      provider('cloud', { kind: 'openai', accessType: 'local' }),
      provider('disabled', { kind: 'ollama', enabled: false }),
      provider('local', { accessType: 'local' })
    ])
    await useStore.getState().loadProviders()
    expect(useStore.getState().activeProviderId).toBe('local')
    expect(bridge.api.listModels).toHaveBeenCalledTimes(1)
    expect(bridge.api.listModels).toHaveBeenCalledWith('local')
  })

  it('clears a cloud selection if Local Only settings arrive after providers', async () => {
    useStore.setState({ settings: undefined })
    bridge.api.listProviders.mockResolvedValue([provider(), provider('local', { accessType: 'local' })])
    await useStore.getState().loadProviders()
    bridge.api.getSettings.mockResolvedValue({ ...DEFAULT_SETTINGS, privacy: { ...DEFAULT_SETTINGS.privacy, localOnly: true } })
    await useStore.getState().loadSettings()
    expect(useStore.getState().activeProviderId).toBeUndefined()
    expect(useStore.getState().models.primary).toBeUndefined()
    await useStore.getState().loadProviders()
    expect(useStore.getState().activeProviderId).toBeUndefined()
  })

  it('rejects blocked provider and preset selections and discards their pending metadata', async () => {
    useStore.setState({ providers: [provider(), provider('local', { accessType: 'local' })], presets: [{ id: 'cloud-preset', name: 'Cloud', providerId: 'primary', model: 'cloud-model' }] })
    useStore.getState().setActive('primary', '')
    const pending = deferred<ModelInfo[]>()
    bridge.api.listModels.mockReturnValueOnce(pending.promise)
    const loading = useStore.getState().loadModels('primary')
    await useStore.getState().saveSettings({ privacy: { ...DEFAULT_SETTINGS.privacy, localOnly: true } })
    useStore.getState().setActive('local', 'local-default')
    useStore.getState().setActive('primary', 'cloud-model')
    useStore.getState().applyPreset('cloud-preset')
    pending.resolve([model('cloud-model')])
    await loading
    expect(useStore.getState().activeProviderId).toBe('local')
    expect(useStore.getState().activePresetId).toBeUndefined()
    expect(useStore.getState().models.primary).toBeUndefined()
  })
})

describe('model reasoning effort', () => {
  const provider = (kind: ProviderKind = 'openai-compat', id = 'effort-provider'): ProviderConfig => ({
    id, name: 'Fixture provider', kind, enabled: true, accessType: 'api', auth: { type: 'none' }, defaultModel: 'fixture-model'
  })
  const model = (supportsReasoning: boolean, id = 'fixture-model', providerId = 'effort-provider'): ModelInfo => ({
    id, providerId, displayName: id, location: 'cloud', capabilities: supportsReasoning ? ['text', 'reasoning'] : ['text'],
    modalities: { input: ['text'], output: ['text'] }, supportsTools: true, supportsStructuredOutput: false, supportsReasoning
  })
  const select = (kind: ProviderKind, selected: ModelInfo | undefined, id = selected?.id ?? 'fixture-model') => {
    useStore.setState({ providers: [provider(kind)], activeProviderId: 'effort-provider', activeModel: id,
      models: { 'effort-provider': selected ? [selected] : [] } })
  }
  const sentParams = () => (bridge.api.startChat.mock.calls.at(-1)?.[0] as ChatStartRequest).policy.primary.params

  it('loads a generic provider without inventing an effort default', async () => {
    useStore.setState({ activeProviderId: undefined, activeModel: undefined, effort: 'max' })
    bridge.api.listProviders.mockResolvedValue([provider()])
    bridge.api.listModels.mockResolvedValue([model(false)])
    await useStore.getState().loadProviders()
    expect(useStore.getState().activeModel).toBe('fixture-model')
    expect(useStore.getState().effort).toBeUndefined()
  })

  it('resets the default when switching from a reasoning model to an unsupported model', () => {
    select('openai', model(true, 'gpt-6-astra'))
    useStore.setState({ models: { 'effort-provider': [model(true, 'gpt-6-astra'), model(false, 'gpt-4o')] } })
    useStore.getState().setActive('effort-provider', 'gpt-6-astra')
    expect(useStore.getState().effort).toBe('medium')
    useStore.getState().setEffort('max')
    useStore.getState().setActive('effort-provider', 'gpt-4o')
    expect(useStore.getState().effort).toBeUndefined()
  })

  it('clears a heuristic default when asynchronously loaded metadata explicitly rejects reasoning', async () => {
    select('openai', undefined, 'gpt-6-astra')
    useStore.getState().setActive('effort-provider', 'gpt-6-astra')
    expect(useStore.getState().effort).toBe('medium')
    let finish!: (models: ModelInfo[]) => void
    bridge.api.listModels.mockImplementationOnce(() => new Promise<ModelInfo[]>((resolve) => { finish = resolve }))
    const loading = useStore.getState().loadModels('effort-provider')
    useStore.getState().setEffort('max')
    finish([model(false, 'gpt-6-astra')])
    await loading
    expect(useStore.getState().effort).toBeUndefined()
    await useStore.getState().sendMessage('ultrathink before answering')
    expect(sentParams()).not.toHaveProperty('reasoningEffort')
  })

  it('does not let another provider metadata response select a model or change effort', async () => {
    select('openai', model(true, 'gpt-6-astra'))
    useStore.setState({ activeModel: '', effort: undefined, providers: [provider('openai'), provider('openai', 'other-provider')] })
    bridge.api.listModels.mockResolvedValueOnce([model(true, 'other-model', 'other-provider')])
    await useStore.getState().loadModels('other-provider')
    expect(useStore.getState().activeModel).toBe('')
    expect(useStore.getState().effort).toBeUndefined()
  })

  it.each([
    ['openai-compat', undefined, 'fixture-model'],
    ['openai-compat', false, 'fixture-model'],
    ['lmstudio', undefined, 'gpt-6-astra'],
    ['llamacpp', false, 'fixture-model'],
    ['openai', false, 'gpt-6-astra'],
    ['openai', undefined, 'gpt-4o'],
    ['anthropic', false, 'claude-opus-4-8'],
    ['anthropic', undefined, 'fixture-model']
  ] as const)('omits stale effort and ultrathink for unsupported %s/%s/%s', async (kind, support, id) => {
    select(kind, support === undefined ? undefined : model(support, id), id)
    useStore.setState({ effort: 'max' })
    await useStore.getState().sendMessage('ultrathink about this')
    expect(sentParams()).not.toHaveProperty('reasoningEffort')
  })

  it('omits stale ordinary effort even without an ultrathink override', async () => {
    select('openai-compat', model(false))
    useStore.setState({ effort: 'medium' })
    await useStore.getState().sendMessage('Hello')
    expect(sentParams()).not.toHaveProperty('reasoningEffort')
  })

  it('keeps Default unset on a supported model and omits the request parameter', async () => {
    select('openai', model(true, 'gpt-6-astra'))
    useStore.getState().setEffort('max')
    useStore.getState().setEffort(undefined)
    expect(useStore.getState().effort).toBeUndefined()
    await useStore.getState().sendMessage('Use normal settings')
    expect(sentParams()).not.toHaveProperty('reasoningEffort')
  })

  it('clamps ultrathink to the selected model supported vocabulary', async () => {
    select('openai', model(true, 'o3'))
    await useStore.getState().sendMessage('ultrathink about the failure')
    expect(sentParams()).toMatchObject({ reasoningEffort: 'high' })
  })

  it('rejects an unsupported preset both before and after its metadata loads', async () => {
    select('openai-compat', model(false))
    useStore.setState({ presets: [{ id: 'preset', name: 'Saved preset', providerId: 'effort-provider', model: 'fixture-model', params: { reasoningEffort: 'max' } }] })
    bridge.api.listModels.mockResolvedValue([model(false)])
    useStore.getState().applyPreset('preset')
    expect(useStore.getState().effort).toBeUndefined()
    await vi.waitFor(() => expect(bridge.api.listModels).toHaveBeenCalled())
    await useStore.getState().sendMessage('Run this preset')
    expect(sentParams()).not.toHaveProperty('reasoningEffort')
  })

  it('applies a supported preset when metadata arrives after selection', async () => {
    select('openai-compat', undefined)
    useStore.setState({ presets: [{ id: 'preset', name: 'Saved preset', providerId: 'effort-provider', model: 'fixture-model', params: { reasoningEffort: 'max' } }] })
    let finish!: (models: ModelInfo[]) => void
    bridge.api.listModels.mockImplementationOnce(() => new Promise<ModelInfo[]>((resolve) => { finish = resolve }))
    useStore.getState().applyPreset('preset')
    expect(useStore.getState().effort).toBeUndefined()
    finish([model(true)])
    await vi.waitFor(() => expect(useStore.getState().effort).toBe('high'))
    await useStore.getState().sendMessage('Run this preset')
    expect(sentParams()).toMatchObject({ reasoningEffort: 'high' })
  })

  it('does not overwrite an explicit Default selection when preset metadata arrives late', async () => {
    select('openai-compat', undefined)
    useStore.setState({ presets: [{ id: 'preset', name: 'Saved preset', providerId: 'effort-provider', model: 'fixture-model', params: { reasoningEffort: 'high' } }] })
    let finish!: (models: ModelInfo[]) => void
    bridge.api.listModels.mockImplementationOnce(() => new Promise<ModelInfo[]>((resolve) => { finish = resolve }))
    useStore.getState().applyPreset('preset')
    useStore.getState().setEffort(undefined)
    finish([model(true)])
    await vi.waitFor(() => expect(useStore.getState().models['effort-provider']?.[0]?.supportsReasoning).toBe(true))
    expect(useStore.getState().effort).toBeUndefined()
  })

  it('does not invent effort for a preset that uses provider defaults', async () => {
    select('openai', model(true, 'gpt-6-astra'))
    useStore.setState({ effort: 'max', presets: [{ id: 'preset', name: 'Default preset', providerId: 'effort-provider', model: 'gpt-6-astra' }] })
    bridge.api.listModels.mockResolvedValue([model(true, 'gpt-6-astra')])
    useStore.getState().applyPreset('preset')
    await useStore.getState().sendMessage('Use the preset defaults')
    expect(sentParams()).not.toHaveProperty('reasoningEffort')
  })

  it('uses fresh capability metadata if it arrives while the initial task is created', async () => {
    select('openai', undefined, 'gpt-6-astra')
    useStore.setState({ activeConversation: undefined, effort: 'max' })
    let finish!: (value: Conversation) => void
    bridge.api.createConversation.mockImplementationOnce(() => new Promise<Conversation>((resolve) => { finish = resolve }))
    const sending = useStore.getState().sendMessage('ultrathink about this')
    useStore.setState({ models: { 'effort-provider': [model(false, 'gpt-6-astra')] } })
    finish(conversation('new'))
    await sending
    expect(sentParams()).not.toHaveProperty('reasoningEffort')
  })
})

describe('task workspace selection', () => {
  beforeEach(() => {
    useStore.setState({ settings: { ...DEFAULT_SETTINGS, general: { ...DEFAULT_SETTINGS.general, workspacePath: 'I:\\a' } } })
  })

  it('creates a new task when switching a task that already belongs to a project', async () => {
    await useStore.getState().setWorkspace('I:\\b')
    expect(bridge.api.updateConversation).not.toHaveBeenCalled()
    expect(bridge.api.createConversation).toHaveBeenCalledWith(expect.objectContaining({ workspacePath: 'I:\\b' }))
    expect(useStore.getState().conversationRuns.a?.activeConversation?.workspacePath).toBe('I:\\a')
    expect(useStore.getState().activeConversation?.workspacePath).toBe('I:\\b')
  })

  it('attaches a chosen project to an idle task with no workspace', async () => {
    useStore.setState({ activeConversation: { ...conversation('a'), workspacePath: undefined } })
    await useStore.getState().setWorkspace('I:\\b')
    expect(bridge.api.createConversation).not.toHaveBeenCalled()
    expect(bridge.api.updateConversation).toHaveBeenCalledWith('a', { workspacePath: 'I:\\b' })
    expect(useStore.getState().activeConversation?.workspacePath).toBe('I:\\b')
  })

  it('clears the merged workspace setting and opens a task without a project', async () => {
    await useStore.getState().clearWorkspace()
    expect(useStore.getState().settings?.general.workspacePath).toBe('')
    expect(useStore.getState().activeConversation?.workspacePath).toBeUndefined()
    expect(bridge.api.createConversation.mock.calls[0]?.[0]).not.toHaveProperty('workspacePath')
    expect(useStore.getState().conversationRuns.a?.activeConversation?.workspacePath).toBe('I:\\a')
  })
})

describe('context accounting and retained history', () => {
  const snapshot = (tokens = 1200): ContextUsageSnapshot => ({
    sections: [{ id: 'system', label: 'System instructions', estimatedTokens: tokens }],
    estimatedTokens: tokens, contextTokens: tokens, contextBasis: 'estimated',
    contextWindow: 128000, outputReserve: 4096, updatedAt: 10
  })
  const turns = () => Array.from({ length: 10 }, (_, i) => ({
    id: `m${i}`, role: i % 2 ? 'assistant' as const : 'user' as const, text: `Message ${i}`, createdAt: i
  }))

  it('receives early context events before startChat returns', async () => {
    bridge.api.startChat.mockImplementationOnce(async (request: ChatStartRequest) => {
      emit({ streamId: request.streamId!, kind: 'context', context: snapshot() })
      return { streamId: request.streamId }
    })
    await useStore.getState().sendMessage('Inspect context')
    expect(useStore.getState().contextUsage?.estimatedTokens).toBe(1200)
  })

  it('keeps background context and measured input with their originating task', async () => {
    await useStore.getState().sendMessage('Inspect A')
    const streamId = useStore.getState().streamId!
    emit({ streamId, kind: 'context', context: snapshot() })
    await useStore.getState().openConversation('b')
    expect(useStore.getState().contextUsage).toBeUndefined()
    emit({ streamId, kind: 'context', context: { ...snapshot(1800), measuredInputTokens: 1775 } })
    expect(useStore.getState().contextUsage).toBeUndefined()
    await useStore.getState().openConversation('a')
    expect(useStore.getState().contextUsage?.measuredInputTokens).toBe(1775)
    useStore.getState().cancel()
    emit({ streamId, kind: 'context', context: snapshot(9999) })
    expect(useStore.getState().contextUsage?.estimatedTokens).toBe(1800)
  })

  it('summarizes older turns through the main process and keeps the transcript whole', async () => {
    const messages = turns()
    useStore.setState({ liveMessages: messages, contextUsage: snapshot() })
    await useStore.getState().compactActive()
    expect(bridge.api.compactConversation).toHaveBeenCalledWith('a')
    expect(useStore.getState().liveMessages).toEqual(messages)
    const active = useStore.getState().activeConversation
    expect(active).toMatchObject({ contextStartMessageId: 'm4', contextSummary: 'Goal: ship the retry fix.' })
    expect(active?.contextSummaryAt).toEqual(expect.any(Number))
    expect(useStore.getState().contextUsage).toBeUndefined()
    expect(useStore.getState().compactingId).toBeUndefined()
    await useStore.getState().restoreFullContext()
    expect(bridge.api.updateConversation).toHaveBeenLastCalledWith('a', { contextStartMessageId: undefined })
    expect(useStore.getState().liveMessages).toEqual(messages)
    expect(useStore.getState().activeConversation).toMatchObject({ contextStartMessageId: undefined, contextSummary: undefined, contextSummaryAt: undefined })
  })

  it('says why a summary could not be made and leaves the conversation alone', async () => {
    bridge.api.compactConversation.mockResolvedValueOnce({ ok: false, error: 'There are not enough earlier messages to summarize.' })
    useStore.setState({ liveMessages: turns() })
    await useStore.getState().compactActive()
    expect(useStore.getState().compactError).toBe('There are not enough earlier messages to summarize.')
    expect(useStore.getState().activeConversation?.contextSummary).toBeUndefined()
    expect(useStore.getState().compactingId).toBeUndefined()
    useStore.getState().dismissCompactError()
    expect(useStore.getState().compactError).toBeUndefined()
  })

  it('reports a summary request that throws', async () => {
    bridge.api.compactConversation.mockRejectedValueOnce(new Error('Gateway unreachable'))
    useStore.setState({ liveMessages: turns() })
    await useStore.getState().compactActive()
    expect(useStore.getState().compactError).toBe('Gateway unreachable')
    expect(useStore.getState().compactingId).toBeUndefined()
  })

  it('does not summarize while a request is running or another summary is in flight', async () => {
    useStore.setState({ liveMessages: turns(), streamId: 'running' })
    await useStore.getState().compactActive()
    useStore.setState({ streamId: undefined, compactingId: 'a' })
    await useStore.getState().compactActive()
    expect(bridge.api.compactConversation).not.toHaveBeenCalled()
  })

  it('applies a summary the running turn made on its own', async () => {
    await useStore.getState().sendMessage('Keep going')
    const streamId = useStore.getState().streamId!
    emit({ streamId, kind: 'compacted', summary: 'Goal: keep going.', boundaryMessageId: 'm4' })
    expect(useStore.getState().activeConversation).toMatchObject({ contextStartMessageId: 'm4', contextSummary: 'Goal: keep going.' })
  })

  it('keeps an automatic summary with the task that made it', async () => {
    await useStore.getState().sendMessage('Task A')
    const streamId = useStore.getState().streamId!
    await useStore.getState().openConversation('b')
    emit({ streamId, kind: 'compacted', summary: 'Goal: task A.', boundaryMessageId: 'm2' })
    expect(useStore.getState().activeConversation?.contextSummary).toBeUndefined()
    expect(useStore.getState().conversationRuns.a?.activeConversation).toMatchObject({ contextStartMessageId: 'm2', contextSummary: 'Goal: task A.' })
  })

  it('takes the context cut from the saved task when a cached one is reopened', async () => {
    await useStore.getState().sendMessage('Task A')
    await useStore.getState().openConversation('b')
    bridge.api.getConversation.mockImplementation(async (id: string) => id === 'a'
      ? { ...conversation('a'), contextStartMessageId: 'm6', contextSummary: 'Saved while away.', contextSummaryAt: 99 }
      : conversation(id))
    await useStore.getState().openConversation('a')
    expect(useStore.getState().activeConversation).toMatchObject({ contextStartMessageId: 'm6', contextSummary: 'Saved while away.', contextSummaryAt: 99 })
  })

  it('does not change the context of a running request', async () => {
    useStore.setState({ liveMessages: turns(), streamId: 'running' })
    await useStore.getState().restoreFullContext()
    expect(bridge.api.updateConversation).not.toHaveBeenCalled()
  })

  it('removes only the selected attachment', () => {
    useStore.getState().addAttachment({ type: 'file', filename: 'one.txt', source: { kind: 'base64', mediaType: 'text/plain', data: 'b25l' } })
    useStore.getState().addAttachment({ type: 'file', filename: 'two.txt', source: { kind: 'base64', mediaType: 'text/plain', data: 'dHdv' } })
    useStore.getState().removeAttachment(0)
    expect(useStore.getState().attachments).toHaveLength(1)
    expect(useStore.getState().attachments[0]).toMatchObject({ filename: 'two.txt' })
  })

  it('retires a stream that fails before startup', async () => {
    bridge.api.startChat.mockRejectedValueOnce(new Error('Provider unavailable'))
    await useStore.getState().sendMessage('Try request')
    expect(useStore.getState().streamId).toBeUndefined()
    expect(useStore.getState().streamOwners).toEqual({})
    expect(useStore.getState().status).toBe('error')
  })

  it('keeps unsent attachments with their task while switching tabs', async () => {
    const attachment = { type: 'file' as const, filename: 'task-a.txt', source: { kind: 'base64' as const, mediaType: 'text/plain', data: 'YQ==' } }
    useStore.getState().addAttachment(attachment)
    await useStore.getState().openConversation('b')
    expect(useStore.getState().attachments).toEqual([])
    await useStore.getState().openConversation('a')
    expect(useStore.getState().attachments).toEqual([attachment])
  })

  it('sends draft attachments when it first creates a conversation', async () => {
    const attachment = { type: 'file' as const, filename: 'new.txt', source: { kind: 'base64' as const, mediaType: 'text/plain', data: 'YQ==' } }
    useStore.setState({ activeConversation: undefined, attachments: [attachment] })
    await useStore.getState().sendMessage('Read this')
    expect(bridge.api.startChat).toHaveBeenCalledWith(expect.objectContaining({ attachments: [attachment] }))
    expect(useStore.getState().liveMessages[0]?.attachments).toEqual([attachment])
  })

  it('clears only sent attachments when request startup finishes late', async () => {
    const first = { type: 'file' as const, filename: 'first.txt', source: { kind: 'base64' as const, mediaType: 'text/plain', data: 'YQ==' } }
    const next = { ...first, filename: 'next.txt' }
    let finish!: (result: { streamId: string }) => void
    bridge.api.startChat.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    useStore.getState().addAttachment(first)
    const sending = useStore.getState().sendMessage('Read first')
    const streamId = useStore.getState().streamId!
    useStore.getState().addAttachment(next)
    await useStore.getState().openConversation('b')
    finish({ streamId })
    await sending
    await useStore.getState().openConversation('a')
    expect(useStore.getState().attachments).toEqual([next])
  })
})

describe('per-task composer drafts', () => {
  it('keeps distinct text and attachment drafts across task navigation and closed tabs', async () => {
    const attachment = { type: 'file' as const, filename: 'draft.txt', source: { kind: 'base64' as const, mediaType: 'text/plain', data: 'YQ==' } }
    useStore.getState().setComposerText('  Task A draft\nwith formatting  ')
    useStore.getState().addAttachment(attachment)
    await useStore.getState().openConversation('b')
    expect(useStore.getState().composerText).toBe('')
    useStore.getState().setComposerText('Task B draft')
    await useStore.getState().openConversation('a')
    expect(useStore.getState().composerText).toBe('  Task A draft\nwith formatting  ')
    expect(useStore.getState().attachments).toEqual([attachment])
    useStore.getState().closeTab('a')
    await vi.waitFor(() => expect(useStore.getState().activeConversation?.id).toBe('b'))
    expect(useStore.getState().composerText).toBe('Task B draft')
    await useStore.getState().openConversation('a')
    expect(useStore.getState().composerText).toContain('Task A draft')
  })

  it('does not resurrect a successfully submitted draft after navigating away and back', async () => {
    useStore.getState().setComposerText('Send this draft')
    await useStore.getState().submitComposer()
    expect(useStore.getState().composerText).toBe('')
    await useStore.getState().openConversation('b')
    await useStore.getState().openConversation('a')
    expect(useStore.getState().composerText).toBe('')
  })

  it('preserves a newer revision even when it has the same text as the submitted draft', async () => {
    let finish!: (result: { streamId: string }) => void
    bridge.api.startChat.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    useStore.getState().setComposerText('Repeat this')
    const sending = useStore.getState().submitComposer()
    const streamId = useStore.getState().streamId!
    useStore.getState().setComposerText('A different thought')
    useStore.getState().setComposerText('Repeat this')
    await useStore.getState().openConversation('b')
    useStore.getState().setComposerText('Keep B untouched')
    finish({ streamId })
    await sending
    expect(useStore.getState().composerText).toBe('Keep B untouched')
    await useStore.getState().openConversation('a')
    expect(useStore.getState().composerText).toBe('Repeat this')
  })

  it('retains a draft when startup fails, and clears it only after a successful retry', async () => {
    bridge.api.startChat.mockRejectedValueOnce(new Error('Provider unavailable'))
    useStore.getState().setComposerText('Keep this request')
    await useStore.getState().submitComposer()
    expect(useStore.getState().composerText).toBe('Keep this request')
    expect(useStore.getState().startingRequest).toBe(false)
    await useStore.getState().submitComposer()
    expect(useStore.getState().composerText).toBe('')
    expect(bridge.api.startChat).toHaveBeenCalledTimes(2)
  })

  it('keeps a welcome draft when conversation creation fails', async () => {
    useStore.setState({ activeConversation: undefined })
    useStore.getState().setComposerText('Create this task')
    bridge.api.createConversation.mockRejectedValueOnce(new Error('Storage unavailable'))
    await useStore.getState().submitComposer()
    expect(useStore.getState().composerText).toBe('Create this task')
    expect(useStore.getState().statusDetail).toBe('Storage unavailable')
    expect(useStore.getState().startingRequest).toBe(false)
    expect(bridge.api.startChat).not.toHaveBeenCalled()
  })

  it('does not send into a different task selected while conversation creation is pending', async () => {
    let created!: (value: Conversation) => void
    bridge.api.createConversation.mockImplementationOnce(() => new Promise<Conversation>((resolve) => { created = resolve }))
    useStore.setState({ activeConversation: undefined, activeTabId: undefined, tabs: [] })
    useStore.getState().setComposerText('Welcome draft')
    const sending = useStore.getState().submitComposer()
    await useStore.getState().openConversation('b')
    useStore.getState().setComposerText('Task B draft')
    created(conversation('created-late'))
    await sending
    expect(bridge.api.startChat).not.toHaveBeenCalled()
    expect(useStore.getState().activeConversation?.id).toBe('b')
    expect(useStore.getState().composerText).toBe('Task B draft')
    useStore.getState().closeTab('b')
    expect(useStore.getState().activeConversation).toBeUndefined()
    expect(useStore.getState().composerText).toBe('Welcome draft')
    expect(useStore.getState().startingRequest).toBe(false)
  })

  it('retains edits made during creation while sending the originally submitted text', async () => {
    let created!: (value: Conversation) => void
    bridge.api.createConversation.mockImplementationOnce(() => new Promise<Conversation>((resolve) => { created = resolve }))
    useStore.setState({ activeConversation: undefined })
    useStore.getState().setComposerText('Original request')
    const sending = useStore.getState().submitComposer()
    await useStore.getState().submitComposer()
    expect(bridge.api.createConversation).toHaveBeenCalledTimes(1)
    useStore.getState().setComposerText('Draft for the next request')
    created(conversation('created'))
    await sending
    expect(bridge.api.startChat).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'created', userText: 'Original request' }))
    expect(useStore.getState().composerText).toBe('Draft for the next request')
    expect(useStore.getState().startingRequest).toBe(false)
  })

  it('leaves a replacement new task usable when it supersedes a pending initial send', async () => {
    let created!: (value: Conversation) => void
    bridge.api.createConversation.mockImplementationOnce(() => new Promise<Conversation>((resolve) => { created = resolve }))
    useStore.setState({ activeConversation: undefined })
    useStore.getState().setComposerText('Preserved initial draft')
    const sending = useStore.getState().submitComposer()
    await useStore.getState().newConversation()
    created(conversation('superseded'))
    await sending
    expect(useStore.getState().activeConversation?.id).toBe('new')
    expect(useStore.getState().startingRequest).toBe(false)
    expect(useStore.getState().composerText).toBe('Preserved initial draft')
    expect(bridge.api.startChat).not.toHaveBeenCalled()
  })

  it('consumes a successful new-task command after its welcome draft transfers to the task', async () => {
    useStore.setState({ activeConversation: undefined })
    useStore.getState().setComposerText('/new')
    await useStore.getState().submitComposer()
    expect(useStore.getState().activeConversation?.id).toBe('new')
    expect(useStore.getState().composerText).toBe('')
    expect(bridge.api.startChat).not.toHaveBeenCalled()
  })

  it('preserves failed command drafts and bounds text memory', async () => {
    useStore.setState({ runSlashCommand: async () => { throw new Error('Could not write context settings') } })
    useStore.getState().setComposerText('/compact')
    await useStore.getState().submitComposer()
    expect(useStore.getState().composerText).toBe('/compact')
    expect(useStore.getState().statusDetail).toContain('Could not write')
    useStore.getState().setComposerText('a'.repeat(COMPOSER_MAX_LENGTH + 20))
    expect(useStore.getState().composerText).toHaveLength(COMPOSER_MAX_LENGTH)
  })
})

describe('continuous live activity', () => {
  it('shows plan preparation after commentary without persisting partial tool arguments', async () => {
    await useStore.getState().sendMessage('Plan the change')
    const streamId = useStore.getState().streamId!
    emit({ streamId, kind: 'stream', event: { type: 'text_delta', text: 'I will prepare the plan.' } })
    emit({ streamId, kind: 'stream', event: { type: 'tool_call_delta', index: 0, name: 'exit_plan_mode' } })
    emit({ streamId, kind: 'stream', event: { type: 'tool_call_delta', index: 0, argsDelta: '{"plan":"private unfinished content' } })
    expect(useStore.getState().status).toBe('preparing_tool')
    expect(useStore.getState().statusDetail).toBe('Preparing plan')
    expect(useStore.getState().liveMessages.at(-1)?.toolCalls).toBeUndefined()
    expect(serializeMessageTranscript(useStore.getState().liveMessages.at(-1)!) ?? '').not.toContain('private unfinished content')
    expect(JSON.stringify(useStore.getState().liveMessages.at(-1))).not.toContain('private unfinished content')
    expect(useStore.getState().liveMessages.at(-1)?.text).toBe('I will prepare the plan.')
    emit({ streamId, kind: 'stream', event: { type: 'tool_call', toolCall: { id: 'plan-call', name: 'exit_plan_mode', input: { plan: 'Ready' } } } })
    expect(useStore.getState().status).toBe('planning')
    expect(useStore.getState().liveMessages.at(-1)?.preparingTools).toBeUndefined()
    emit({ streamId, kind: 'plan', ask: plan() })
    expect(useStore.getState().status).toBe('awaiting_input')
  })

  it('seals reasoning before preparing a tool and keeps the correct name across interleaved chunks', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1000)
      await useStore.getState().sendMessage('Edit the file')
      const streamId = useStore.getState().streamId!
      emit({ streamId, kind: 'stream', event: { type: 'reasoning_delta', text: 'Choose the minimal change.' } })
      vi.setSystemTime(1500)
      emit({ streamId, kind: 'stream', event: { type: 'tool_call_delta', index: 0, name: 'edit_file' } })
      expect(useStore.getState().liveMessages.at(-1)?.reasoningStart).toBeUndefined()
      expect(useStore.getState().liveMessages.at(-1)?.reasoningMs).toBe(500)
      emit({ streamId, kind: 'stream', event: { type: 'tool_call_delta', index: 1, name: 'run_command' } })
      expect(useStore.getState().statusDetail).toBe('Preparing command')
      emit({ streamId, kind: 'stream', event: { type: 'tool_call_delta', index: 0, argsDelta: '{}' } })
      expect(useStore.getState().statusDetail).toBe('Preparing edit')
    } finally { vi.useRealTimers() }
  })

  it('keeps an outstanding parallel tool active when another tool finishes', async () => {
    useStore.setState({ permissionMode: 'default' })
    await useStore.getState().sendMessage('Inspect both files')
    const streamId = useStore.getState().streamId!
    emit({ streamId, kind: 'tool', tool: { id: 'read', name: 'read_file', title: 'Read file', phase: 'running' } })
    emit({ streamId, kind: 'tool', tool: { id: 'edit', name: 'edit_file', title: 'Edit file', phase: 'running' } })
    emit({ streamId, kind: 'tool', tool: { id: 'read', name: 'read_file', phase: 'done' } })
    expect(useStore.getState().status).toBe('editing')
    expect(useStore.getState().statusDetail).toBe('Edit file')
    emit({ streamId, kind: 'tool', tool: { id: 'edit', name: 'edit_file', phase: 'done' } })
    expect(useStore.getState().status).toBe('working')
    expect(useStore.getState().liveMessages.at(-1)?.streaming).toBe(true)
  })

  it('does not return to animated work while a user decision is pending', async () => {
    await useStore.getState().sendMessage('Prepare a plan')
    const streamId = useStore.getState().streamId!
    emit({ streamId, kind: 'plan', ask: plan() })
    for (const event of [
      { type: 'tool_call_delta' as const, index: 0, name: 'exit_plan_mode' },
      { type: 'reasoning_delta' as const, text: 'A buffered thought.' },
      { type: 'text_delta' as const, text: 'A buffered line.' }
    ]) {
      emit({ streamId, kind: 'stream', event })
      expect(useStore.getState().status).toBe('awaiting_input')
    }
    expect(useStore.getState().statusDetail).toBe('Plan ready for review')
  })

  it('clears preparation on cancellation and ignores its late chunks', async () => {
    await useStore.getState().sendMessage('Prepare a plan')
    const streamId = useStore.getState().streamId!
    emit({ streamId, kind: 'stream', event: { type: 'tool_call_delta', index: 0, name: 'exit_plan_mode' } })
    useStore.getState().cancel()
    emit({ streamId, kind: 'stream', event: { type: 'tool_call_delta', index: 0, argsDelta: '{}' } })
    expect(useStore.getState().status).toBe('cancelled')
    expect(useStore.getState().liveMessages.at(-1)?.preparingTools).toBeUndefined()
    expect(useStore.getState().liveMessages.at(-1)?.streaming).toBe(false)
  })

  it('scopes preparation to its task when another task is on screen', async () => {
    await useStore.getState().sendMessage('Prepare a plan')
    const streamId = useStore.getState().streamId!
    await useStore.getState().openConversation('b')
    emit({ streamId, kind: 'stream', event: { type: 'tool_call_delta', index: 0, name: 'exit_plan_mode' } })
    expect(useStore.getState().status).toBe('idle')
    expect(useStore.getState().conversationRuns.a?.status).toBe('preparing_tool')
    expect(useStore.getState().conversationRuns.a?.statusDetail).toBe('Preparing plan')
    await useStore.getState().openConversation('a')
    expect(useStore.getState().statusDetail).toBe('Preparing plan')
  })
})

describe('durable activity history', () => {
  it('keeps text, parallel tool calls, and follow-up text in event order through persistence', async () => {
    await useStore.getState().sendMessage('Inspect both files')
    const streamId = useStore.getState().streamId!
    emit({ streamId, sequence: 1, kind: 'iteration', iteration: 0 })
    emit({ streamId, sequence: 2, kind: 'stream', event: { type: 'text_delta', text: 'I will inspect both files.' } })
    emit({ streamId, sequence: 3, kind: 'stream', event: { type: 'tool_call', toolCall: { id: 'read-a', name: 'read_file', input: { path: 'a.ts' } } } })
    emit({ streamId, sequence: 4, kind: 'tool', tool: { id: 'read-a', name: 'read_file', phase: 'running', title: 'Read a.ts' } })
    emit({ streamId, sequence: 5, kind: 'tool', tool: { id: 'read-b', name: 'read_file', phase: 'running', title: 'Read b.ts' } })
    emit({ streamId, sequence: 6, kind: 'tool', tool: { id: 'read-b', name: 'read_file', phase: 'done', detail: 'Second file completed first.' } })
    emit({ streamId, sequence: 7, kind: 'tool', tool: { id: 'read-a', name: 'read_file', phase: 'done', detail: 'First file completed second.' } })
    emit({ streamId, sequence: 8, kind: 'iteration', iteration: 1 })
    emit({ streamId, sequence: 9, kind: 'stream', event: { type: 'text_delta', text: 'Both files use the same parser.' } })
    const live = useStore.getState().liveMessages.at(-1)!
    expect(live.blocks).toEqual([
      { type: 'text', text: 'I will inspect both files.' },
      { type: 'tool', tool: expect.objectContaining({ id: 'read-a', title: 'Read a.ts', phase: 'done' }) },
      { type: 'tool', tool: expect.objectContaining({ id: 'read-b', title: 'Read b.ts', phase: 'done' }) },
      { type: 'text', text: 'Both files use the same parser.' }
    ])
    expect(live.text).toBe('I will inspect both files.\n\nBoth files use the same parser.')
    useStore.getState().cancel()
    await vi.waitFor(() => expect(bridge.api.updateConversation).toHaveBeenCalled())
    const saved = bridge.api.updateConversation.mock.calls.at(-1)?.[1].messages as StoredMessage[]
    bridge.api.getConversation.mockResolvedValueOnce({ ...conversation('reopened'), messages: saved })
    useStore.setState({ activeConversation: conversation('away'), conversationRuns: {} })
    await useStore.getState().openConversation('reopened')
    expect(useStore.getState().liveMessages.at(-1)?.blocks).toEqual(live.blocks)
    expect(useStore.getState().liveMessages.at(-1)?.text).toBe(live.text)
  })

  it('separates request boundaries without inserting whitespace between streamed chunks', async () => {
    await useStore.getState().sendMessage('Continue checking')
    const streamId = useStore.getState().streamId!
    emit({ streamId, kind: 'iteration', iteration: 1 })
    for (const text of ['First', ' sentence.']) emit({ streamId, kind: 'stream', event: { type: 'text_delta', text } })
    emit({ streamId, kind: 'iteration', iteration: 2 })
    emit({ streamId, kind: 'iteration', iteration: 2 })
    emit({ streamId, kind: 'stream', event: { type: 'text_delta', text: '' } })
    for (const text of ['Next', ' sentence.']) emit({ streamId, kind: 'stream', event: { type: 'text_delta', text } })
    expect(useStore.getState().liveMessages.at(-1)?.text).toBe('First sentence.\n\nNext sentence.')
    expect(useStore.getState().liveMessages.at(-1)?.blocks).toEqual([
      { type: 'text', text: 'First sentence.' }, { type: 'text', text: 'Next sentence.' }
    ])
  })

  it('ignores replayed and stale sequenced events across task navigation', async () => {
    await useStore.getState().sendMessage('Review task A')
    const streamId = useStore.getState().streamId!
    emit({ streamId, sequence: 1, kind: 'stream', event: { type: 'text_delta', text: 'Keep this once.' } })
    await useStore.getState().openConversation('b')
    emit({ streamId, sequence: 1, kind: 'stream', event: { type: 'text_delta', text: 'Keep this once.' } })
    emit({ streamId, sequence: 4, kind: 'tool', tool: { id: 'read', name: 'read_file', phase: 'done' } })
    emit({ streamId, sequence: 2, kind: 'tool', tool: { id: 'read', name: 'read_file', phase: 'running' } })
    emit({ streamId, sequence: 3, kind: 'permission', ask: { id: 'old', toolName: 'read_file', title: 'Older permission request' } })
    expect(useStore.getState().liveMessages).toEqual([])
    await useStore.getState().openConversation('a')
    expect(useStore.getState().liveMessages.at(-1)?.text).toBe('Keep this once.')
    expect(useStore.getState().liveMessages.at(-1)?.toolCalls?.[0]?.phase).toBe('done')
    expect(useStore.getState().pendingPermission).toBeUndefined()
    useStore.getState().cancel()
    emit({ streamId, sequence: 5, kind: 'stream', event: { type: 'text_delta', text: 'Late cancelled text' } })
    expect(useStore.getState().liveMessages.at(-1)?.text).toBe('Keep this once.')
  })

  it('does not let legacy delayed starts reopen completed tools', async () => {
    await useStore.getState().sendMessage('Run the check')
    const streamId = useStore.getState().streamId!
    emit({ streamId, kind: 'tool', tool: { id: 'check', name: 'run_command', phase: 'done', detail: 'Passed' } })
    emit({ streamId, kind: 'tool', tool: { id: 'check', name: 'run_command', phase: 'running' } })
    expect(useStore.getState().liveMessages.at(-1)?.blocks).toEqual([{ type: 'tool', tool: { id: 'check', name: 'run_command', phase: 'done', detail: 'Passed' } }])
  })

  it('measures separate reasoning spans and closes the last one on cancellation', async () => {
    const clock = vi.spyOn(Date, 'now')
    clock.mockReturnValue(1000)
    try {
      await useStore.getState().sendMessage('Review the result')
      const streamId = useStore.getState().streamId!
      emit({ streamId, kind: 'iteration', iteration: 1 })
      emit({ streamId, kind: 'stream', event: { type: 'reasoning_delta', text: 'Read first.' } })
      clock.mockReturnValue(1200)
      emit({ streamId, kind: 'tool', tool: { id: 'read', name: 'read_file', phase: 'done' } })
      emit({ streamId, kind: 'iteration', iteration: 2 })
      clock.mockReturnValue(1500)
      emit({ streamId, kind: 'stream', event: { type: 'reasoning_delta', text: 'Check the result.' } })
      clock.mockReturnValue(1900)
      useStore.getState().cancel()
      expect(useStore.getState().liveMessages.at(-1)?.blocks).toEqual([
        { type: 'reasoning', text: 'Read first.', durationMs: 200 },
        { type: 'tool', tool: { id: 'read', name: 'read_file', phase: 'done' } },
        { type: 'reasoning', text: 'Check the result.', durationMs: 400 }
      ])
      expect(useStore.getState().liveMessages.at(-1)?.reasoningMs).toBe(600)
      expect(useStore.getState().liveMessages.at(-1)?.reasoningStart).toBeUndefined()
    } finally { clock.mockRestore() }
  })

  it('persists and rehydrates reasoning, tool details, diffs, and task-scoped output ownership', async () => {
    await useStore.getState().sendMessage('Review and update the file')
    const streamId = useStore.getState().streamId!
    emit({ streamId, kind: 'stream', event: { type: 'reasoning_delta', text: 'Review the existing format first.' } })
    emit({ streamId, kind: 'tool', tool: { id: 'edit-1', name: 'edit_file', phase: 'done', title: 'Edit config.ts', detail: 'Updated the reviewed key.', added: 1, removed: 1, diff: '@@ -1 +1 @@\n-old\n+new', outputId: 'saved-output', outputConversationId: 'old-import-owner' } })
    emit({ streamId, kind: 'stream', event: { type: 'text_delta', text: 'The change is verified.' } })
    emit({ streamId, kind: 'stream', event: { type: 'completed', response: { id: 'reply', provider: 'mock', model: 'mock-1', text: 'The change is verified.', content: [], toolCalls: [], stopReason: 'stop', createdAt: 2 } } })
    await vi.waitFor(() => expect(bridge.api.updateConversation).toHaveBeenCalled())
    const saved = bridge.api.updateConversation.mock.calls.find(([id, value]) => id === 'a' && value.messages)?.[1].messages as StoredMessage[]
    expect(saved.at(-1)?.uiTranscriptJson).toContain('Review the existing format')
    expect(saved.at(-1)?.uiTranscriptJson).toContain('saved-output')
    bridge.api.getConversation.mockResolvedValueOnce({ ...conversation('imported-task'), messages: saved })
    useStore.setState({ activeConversation: conversation('elsewhere'), conversationRuns: {} })
    await useStore.getState().openConversation('imported-task')
    const restored = useStore.getState().liveMessages.at(-1)!
    expect(restored.reasoning).toBe('Review the existing format first.')
    expect(restored.reasoningMs).toEqual(expect.any(Number))
    expect(restored.toolCalls?.[0]).toMatchObject({ phase: 'done', diff: '@@ -1 +1 @@\n-old\n+new', outputId: 'saved-output', outputConversationId: 'imported-task' })
    expect(restored.blocks?.map((block) => block.type)).toEqual(['reasoning', 'tool', 'text'])
    expect(restored.text).toBe('The change is verified.')
  })

  it('settles unfinished cards and persists partial activity on errors and cancellation', async () => {
    await useStore.getState().sendMessage('Start a long command')
    const streamId = useStore.getState().streamId!
    emit({ streamId, kind: 'tool', tool: { id: 'read-done', name: 'read_file', phase: 'done', detail: 'Read the task settings.' } })
    emit({ streamId, kind: 'tool', tool: { id: 'command-open', name: 'run_command', phase: 'running', detail: 'Running checks.' } })
    emit({ streamId, kind: 'stream', event: { type: 'error', error: new NormalizedAIError({ provider: 'mock', category: 'UNKNOWN', message: 'Connection lost', classification: 'permanent', retryable: false }) } })
    expect(useStore.getState().liveMessages.at(-1)?.toolCalls).toEqual([
      expect.objectContaining({ id: 'read-done', phase: 'done' }),
      expect.objectContaining({ id: 'command-open', phase: 'error', interrupted: true })
    ])
    await vi.waitFor(() => expect(bridge.api.updateConversation).toHaveBeenCalled())
    const failed = bridge.api.updateConversation.mock.calls.at(-1)?.[1].messages as StoredMessage[]
    expect(failed.at(-1)?.uiTranscriptJson).toContain('Interrupted')
    bridge.api.updateConversation.mockClear()
    await useStore.getState().sendMessage('Try the command again')
    emit({ streamId: useStore.getState().streamId!, kind: 'tool', tool: { id: 'command-again', name: 'run_command', phase: 'running' } })
    useStore.getState().cancel()
    expect(useStore.getState().liveMessages.at(-1)?.toolCalls?.[0]).toMatchObject({ phase: 'error', interrupted: true })
    await vi.waitFor(() => expect(bridge.api.updateConversation).toHaveBeenCalled())
  })

  it('keeps terminal state and memory history when a best-effort history write fails', async () => {
    await useStore.getState().sendMessage('Check persistence')
    const streamId = useStore.getState().streamId!
    bridge.api.updateConversation.mockRejectedValueOnce(new Error('Disk unavailable'))
    emit({ streamId, kind: 'stream', event: { type: 'text_delta', text: 'Retained in memory' } })
    useStore.getState().cancel()
    await vi.waitFor(() => expect(useStore.getState().debug.events).toContain('history_save_failed'))
    expect(useStore.getState().status).toBe('cancelled')
    expect(useStore.getState().liveMessages.at(-1)?.text).toBe('Retained in memory')
  })

  it('preserves original content parts and ordered metadata when re-saving a reopened task', async () => {
    const uiTranscriptJson = serializeMessageTranscript({ blocks: [
      { type: 'text', text: 'Before reading.' },
      { type: 'tool', tool: { id: 'read', name: 'read_file', phase: 'done' } },
      { type: 'text', text: 'After reading.' }
    ] })
    const contentJson = JSON.stringify([{ type: 'text', text: 'Before reading. After reading.' }])
    bridge.api.getConversation.mockResolvedValueOnce({ ...conversation('saved'), messages: [{ id: 'old', role: 'assistant', text: 'Before reading. After reading.', createdAt: 1, contentJson, uiTranscriptJson }] })
    await useStore.getState().openConversation('saved')
    useStore.getState().cancel()
    await vi.waitFor(() => expect(bridge.api.updateConversation).toHaveBeenCalled())
    const saved = bridge.api.updateConversation.mock.calls.at(-1)?.[1].messages as StoredMessage[]
    expect(saved[0]?.contentJson).toBe(contentJson)
    expect(JSON.parse(saved[0]!.uiTranscriptJson!).blocks.map((block: { type: string }) => block.type)).toEqual(['text', 'tool', 'text'])
  })
})
