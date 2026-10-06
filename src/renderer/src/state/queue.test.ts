import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent, ChatStartRequest, Conversation } from '../../../shared/ipc'
import { DEFAULT_SETTINGS } from '../../../shared/settings'
import { NormalizedAIError, type ProviderConfig } from '@core/types'

const bridge = vi.hoisted(() => ({
  listeners: new Set<(event: ChatEvent) => void>(),
  api: {
    startChat: vi.fn(), cancelChat: vi.fn(), onChatEvent: vi.fn(), listPlans: vi.fn(),
    getConversation: vi.fn(), listConversations: vi.fn(), updateConversation: vi.fn(), createConversation: vi.fn(),
    listModels: vi.fn(), listProviders: vi.fn(), getSettings: vi.fn(), updateSettings: vi.fn(), compactConversation: vi.fn()
  }
}))
vi.mock('../lib/api', () => ({ api: bridge.api }))
import { useStore } from './store'
import { conditionsFor, pullIntoComposer, useQueue } from './queue'

const provider: ProviderConfig = { id: 'mock', kind: 'mock', name: 'Mock', accessType: 'api', auth: { type: 'none' }, enabled: true }
const conversation = (id: string): Conversation => ({ id, title: `Task ${id}`, createdAt: 1, updatedAt: 1, execution: 'cloud', workspacePath: `I:\\${id}`, messages: [] })
const emit = (event: ChatEvent): void => { for (const listener of [...bridge.listeners]) listener(event) }
const image = { type: 'image' as const, source: { kind: 'base64' as const, mediaType: 'image/png', data: 'AAAA' } }

const completed = (streamId: string): void => emit({ streamId, kind: 'stream', event: { type: 'completed', response: {
  id: 'reply', provider: 'mock', model: 'mock-1', text: 'Done.', content: [{ type: 'text', text: 'Done.' }], toolCalls: [], stopReason: 'stop', createdAt: 2
} } })
const failed = (streamId: string): void => emit({ streamId, kind: 'stream', event: { type: 'error', error: new NormalizedAIError({
  provider: 'mock', category: 'UNKNOWN', message: 'Disconnected', classification: 'permanent', retryable: false
}) } })

/** Everything the queue sent so far, in order. */
const sent = (): string[] => bridge.api.startChat.mock.calls.map(([request]) => (request as ChatStartRequest).userText)
const queued = (id = 'a'): string[] => (useQueue.getState().queues[id] ?? []).map((item) => item.text)

beforeEach(() => {
  vi.clearAllMocks()
  bridge.listeners.clear()
  bridge.api.onChatEvent.mockImplementation((callback: (event: ChatEvent) => void) => {
    bridge.listeners.add(callback)
    return () => bridge.listeners.delete(callback)
  })
  bridge.api.startChat.mockImplementation(async (request: ChatStartRequest) => ({ streamId: request.streamId }))
  bridge.api.cancelChat.mockResolvedValue(undefined)
  bridge.api.listPlans.mockResolvedValue([])
  bridge.api.getConversation.mockImplementation(async (id: string) => conversation(id))
  bridge.api.listConversations.mockResolvedValue([])
  bridge.api.updateConversation.mockResolvedValue(undefined)
  bridge.api.listModels.mockResolvedValue([])
  bridge.api.listProviders.mockResolvedValue([provider])
  bridge.api.getSettings.mockResolvedValue(DEFAULT_SETTINGS)
  useQueue.setState({ queues: {} })
  useStore.setState(useStore.getInitialState(), true)
  useStore.setState({ activeConversation: conversation('a'), activeTabId: 'a', providers: [provider], activeProviderId: 'mock', activeModel: 'mock-1', settings: DEFAULT_SETTINGS })
  useStore.getState()._initChatEvents()
})

/** Start a turn and let it run: the state a person is in when they type the next instruction. */
async function startRunningTurn(text = 'first'): Promise<string> {
  await useStore.getState().sendMessage(text)
  return useStore.getState().streamId!
}

describe('queueing while a turn runs', () => {
  it('holds a message until the turn finishes, then sends it by itself', async () => {
    const streamId = await startRunningTurn()
    expect(useQueue.getState().add('a', { text: 'second', attachments: [] })).toBe(true)
    await Promise.resolve()
    expect(sent()).toEqual(['first'])

    completed(streamId)
    await vi.waitFor(() => expect(sent()).toEqual(['first', 'second']))
    expect(queued()).toEqual([])
    // The queued message shows in the thread like any other, and a new turn is running.
    expect(useStore.getState().liveMessages.filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['first', 'second'])
    expect(useStore.getState().streamId).toBeTruthy()
  })

  it('sends several messages one at a time, each after the previous turn ends', async () => {
    const first = await startRunningTurn()
    useQueue.getState().add('a', { text: 'second', attachments: [] })
    useQueue.getState().add('a', { text: 'third', attachments: [] })
    completed(first)
    await vi.waitFor(() => expect(sent()).toEqual(['first', 'second']))
    expect(queued()).toEqual(['third'])
    completed(useStore.getState().streamId!)
    await vi.waitFor(() => expect(sent()).toEqual(['first', 'second', 'third']))
    expect(queued()).toEqual([])
  })

  it('keeps a message, attachments included, exactly as it was typed', async () => {
    const streamId = await startRunningTurn()
    useQueue.getState().add('a', { text: '  look at this  ', attachments: [image] })
    completed(streamId)
    await vi.waitFor(() => expect(sent()).toHaveLength(2))
    expect((bridge.api.startChat.mock.calls[1]![0] as ChatStartRequest).attachments).toEqual([image])
    expect(useStore.getState().liveMessages.find((m) => m.text === 'look at this')?.attachments).toEqual([image])
  })

  it('does not touch the draft or the attachments being prepared for the next message', async () => {
    const streamId = await startRunningTurn()
    useQueue.getState().add('a', { text: 'queued', attachments: [] })
    useStore.getState().setComposerText('still typing')
    useStore.getState().addAttachment(image)
    completed(streamId)
    await vi.waitFor(() => expect(sent()).toHaveLength(2))
    expect(useStore.getState().composerText).toBe('still typing')
    expect(useStore.getState().attachments).toEqual([image])
  })

  it('refuses an empty message and stops growing at the limit', () => {
    expect(useQueue.getState().add('a', { text: '   ', attachments: [] })).toBe(false)
    for (let index = 0; index < 20; index++) expect(useQueue.getState().add('a', { text: `m${index}`, attachments: [] })).toBe(true)
    expect(useQueue.getState().add('a', { text: 'too many', attachments: [] })).toBe(false)
    expect(queued()).toHaveLength(20)
  })
})

describe('when the queue holds', () => {
  it('holds after the turn failed and sends nothing', async () => {
    const streamId = await startRunningTurn()
    useQueue.getState().add('a', { text: 'second', attachments: [] })
    failed(streamId)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sent()).toEqual(['first'])
    expect(queued()).toEqual(['second'])
    expect(conditionsFor(useStore.getState(), 'a').lastEnd).toBe('failed')
  })

  it('holds after the person stopped the turn', async () => {
    await startRunningTurn()
    useQueue.getState().add('a', { text: 'second', attachments: [] })
    useStore.getState().cancel()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sent()).toEqual(['first'])
    expect(queued()).toEqual(['second'])
    expect(conditionsFor(useStore.getState(), 'a').lastEnd).toBe('stopped')
  })

  it('holds while the turn waits for an answer, and still sends after the turn finishes', async () => {
    const streamId = await startRunningTurn()
    emit({ streamId, kind: 'permission', ask: { id: 'ask-1', toolName: 'run_command', title: 'Run npm test' } })
    useQueue.getState().add('a', { text: 'second', attachments: [] })
    expect(conditionsFor(useStore.getState(), 'a').needsAnswer).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sent()).toEqual(['first'])
    completed(streamId)
    await vi.waitFor(() => expect(sent()).toEqual(['first', 'second']))
  })

  it('goes on after a held turn is followed by one that finishes normally', async () => {
    const first = await startRunningTurn()
    useQueue.getState().add('a', { text: 'queued', attachments: [] })
    failed(first)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sent()).toEqual(['first'])
    // The person tries again by hand; when that turn completes, the queue is next.
    await useStore.getState().sendMessage('manual retry')
    completed(useStore.getState().streamId!)
    await vi.waitFor(() => expect(sent()).toEqual(['first', 'manual retry', 'queued']))
  })

  it('holds without a model and sends once one is chosen', async () => {
    const streamId = await startRunningTurn()
    useQueue.getState().add('a', { text: 'second', attachments: [] })
    useStore.setState({ activeModel: undefined })
    completed(streamId)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(sent()).toEqual(['first'])
    expect(queued()).toEqual(['second'])
    useStore.setState({ activeModel: 'mock-1' })
    await vi.waitFor(() => expect(sent()).toEqual(['first', 'second']))
  })

  it('keeps a message the store refused to send, and does not retry in a tight loop', async () => {
    // Its own task: a refused send makes the runner wait a second before trying that task again.
    useStore.setState({ activeConversation: conversation('refused'), activeTabId: 'refused' })
    const streamId = await startRunningTurn()
    useQueue.getState().add('refused', { text: 'second', attachments: [] })
    const refuse = vi.fn(async () => false)
    useStore.setState({ sendMessage: refuse })
    completed(streamId)
    await vi.waitFor(() => expect(refuse).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(refuse).toHaveBeenCalledTimes(1)
    expect(queued('refused')).toEqual(['second'])
  })
})

describe('across tasks', () => {
  it('keeps each task queue while another task is open and sends only for the task on screen', async () => {
    const streamId = await startRunningTurn()
    useQueue.getState().add('a', { text: 'for a', attachments: [] })
    await useStore.getState().openConversation('b')
    completed(streamId)
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Task a finished while b was open: its message waits for a to be opened.
    expect(sent()).toEqual(['first'])
    expect(queued('a')).toEqual(['for a'])
    await useStore.getState().openConversation('a')
    await vi.waitFor(() => expect(sent()).toEqual(['first', 'for a']))
  })

  it('drops the queue of a task that was deleted', async () => {
    await startRunningTurn()
    useQueue.getState().add('a', { text: 'second', attachments: [] })
    useQueue.setState((state) => ({ queues: { ...state.queues, ghost: [{ id: 'g', text: 'orphan', attachments: [], queuedAt: 1 }] } }))
    useStore.getState().openConversation('b').catch(() => undefined)
    await vi.waitFor(() => expect(useQueue.getState().queues.ghost).toBeUndefined())
    expect(queued('a')).toEqual(['second'])
  })
})

describe('acting on a queued message', () => {
  it('takes it back into the composer with its attachments, below nothing the person typed', async () => {
    await startRunningTurn()
    useQueue.getState().add('a', { text: 'second', attachments: [image] })
    const id = useQueue.getState().queues.a![0]!.id
    expect(pullIntoComposer('a', id)).toBe(true)
    expect(useStore.getState().composerText).toBe('second')
    expect(useStore.getState().attachments).toEqual([image])
    expect(queued()).toEqual([])
    expect(pullIntoComposer('a', id)).toBe(false)
  })

  it('puts the typed draft above a message taken back, so neither is lost', async () => {
    await startRunningTurn()
    useQueue.getState().add('a', { text: 'queued text', attachments: [] })
    useStore.getState().setComposerText('half a thought')
    pullIntoComposer('a', useQueue.getState().queues.a![0]!.id)
    expect(useStore.getState().composerText).toBe('half a thought\n\nqueued text')
  })

  it('removes a message without sending it', async () => {
    const streamId = await startRunningTurn()
    useQueue.getState().add('a', { text: 'dropped', attachments: [] })
    useQueue.getState().add('a', { text: 'kept', attachments: [] })
    useQueue.getState().remove('a', useQueue.getState().queues.a![0]!.id)
    completed(streamId)
    await vi.waitFor(() => expect(sent()).toEqual(['first', 'kept']))
  })

  it('stops the running turn, waits for it to end, then sends the chosen message first', async () => {
    const streamId = await startRunningTurn()
    useQueue.getState().add('a', { text: 'later', attachments: [] })
    useQueue.getState().add('a', { text: 'now please', attachments: [] })
    const chosen = useQueue.getState().queues.a![1]!.id
    const sending = useQueue.getState().sendNow('a', chosen)
    // The turn is cancelled, but the new one must wait for main to retire the old stream.
    await vi.waitFor(() => expect(bridge.api.cancelChat).toHaveBeenCalledWith(streamId))
    expect(sent()).toEqual(['first'])
    failed(streamId)
    await sending
    expect(sent()).toEqual(['first', 'now please'])
    // The turn it interrupted is stopped, so the rest of the queue holds until the new turn ends well.
    expect(queued()).toEqual(['later'])
    completed(useStore.getState().streamId!)
    await vi.waitFor(() => expect(sent()).toEqual(['first', 'now please', 'later']))
  })

  it('sends straight away when the queue is on hold and nothing is running', async () => {
    const streamId = await startRunningTurn()
    useQueue.getState().add('a', { text: 'held', attachments: [] })
    failed(streamId)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await useQueue.getState().sendNow('a', useQueue.getState().queues.a![0]!.id)
    expect(sent()).toEqual(['first', 'held'])
    expect(bridge.api.cancelChat).not.toHaveBeenCalled()
  })

  it('keeps a message in its place when Send now is used while the summary is being written', async () => {
    const streamId = await startRunningTurn()
    completed(streamId)
    await new Promise((resolve) => setTimeout(resolve, 5))
    useStore.setState({ compactingId: 'a' })
    useQueue.getState().add('a', { text: 'waits', attachments: [] })
    await useQueue.getState().sendNow('a', useQueue.getState().queues.a![0]!.id)
    expect(sent()).toEqual(['first'])
    expect(queued()).toEqual(['waits'])
    useStore.setState({ compactingId: undefined })
    await vi.waitFor(() => expect(sent()).toEqual(['first', 'waits']))
  })

  it('runs a queued command the way typing it would, instead of sending it to the model', async () => {
    const streamId = await startRunningTurn()
    useQueue.getState().add('a', { text: '/goal ship the fix', attachments: [] })
    completed(streamId)
    await vi.waitFor(() => expect(useStore.getState().sessionGoal).toBe('ship the fix'))
    expect(sent()).toEqual(['first'])
    expect(queued()).toEqual([])
  })
})
