import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent, Conversation } from '../../../shared/ipc'
import { DEFAULT_SETTINGS } from '../../../shared/settings'

const bridge = vi.hoisted(() => ({
  listeners: new Set<(event: ChatEvent) => void>(),
  api: {
    onChatEvent: vi.fn(), getConversation: vi.fn(), listConversations: vi.fn(), updateConversation: vi.fn(),
    listPlans: vi.fn(), listModels: vi.fn(), listProviders: vi.fn(), getSettings: vi.fn()
  }
}))
vi.mock('../lib/api', () => ({ api: bridge.api }))
import { useStore } from './store'

const conversation = (id: string): Conversation => ({
  id, title: `Task ${id}`, createdAt: 1, updatedAt: 1, execution: 'cloud', workspacePath: `I:\\${id}`, messages: []
})
const emit = (event: ChatEvent): void => { for (const listener of bridge.listeners) listener(event) }
const sent = (extra: Partial<Extract<ChatEvent, { kind: 'userMessage' }>> = {}): ChatEvent =>
  ({ streamId: 's1', kind: 'userMessage', messageId: 'm1', text: 'Review comments on your changes: 1 comment in 1 file.', conversationId: 'a', sequence: 1, ...extra })

beforeEach(() => {
  vi.clearAllMocks()
  bridge.listeners.clear()
  bridge.api.onChatEvent.mockImplementation((callback: (event: ChatEvent) => void) => {
    bridge.listeners.add(callback)
    return () => bridge.listeners.delete(callback)
  })
  bridge.api.getConversation.mockImplementation(async (id: string) => conversation(id))
  bridge.api.listConversations.mockResolvedValue([])
  bridge.api.updateConversation.mockResolvedValue(undefined)
  bridge.api.listPlans.mockResolvedValue([])
  bridge.api.listModels.mockResolvedValue([])
  bridge.api.listProviders.mockResolvedValue([])
  bridge.api.getSettings.mockResolvedValue(DEFAULT_SETTINGS)
  useStore.setState(useStore.getInitialState(), true)
  useStore.setState({ activeConversation: conversation('a'), activeTabId: 'a', activeProviderId: 'mock', activeModel: 'mock-1' })
  useStore.getState()._initChatEvents()
})

describe('a turn the main process starts for the person', () => {
  it('shows the message it sent and follows the stream that answers it', () => {
    emit(sent())
    const state = useStore.getState()
    expect(state.liveMessages.map((message) => [message.id, message.role, message.streaming ?? false])).toEqual([['m1', 'user', false], [expect.any(String), 'assistant', true]])
    expect(state.liveMessages[0]!.text).toContain('Review comments on your changes')
    expect(state.streamId).toBe('s1')
    expect(state.status).toBe('thinking')
    expect(state.streamOwners).toEqual({ s1: 'a' })

    emit({ streamId: 's1', kind: 'stream', sequence: 2, conversationId: 'a', event: { type: 'text_delta', text: 'Renaming the helper.' } })
    expect(useStore.getState().liveMessages.at(-1)!.text).toBe('Renaming the helper.')
  })

  it('settles like any other turn and is saved with the task it belongs to', async () => {
    emit(sent())
    emit({ streamId: 's1', kind: 'stream', sequence: 2, conversationId: 'a', event: { type: 'text_delta', text: 'Done.' } })
    emit({ streamId: 's1', kind: 'stream', sequence: 3, conversationId: 'a', event: { type: 'completed', response: {
      id: 'reply', provider: 'mock', model: 'mock-1', text: 'Done.', content: [{ type: 'text', text: 'Done.' }], toolCalls: [], stopReason: 'stop', createdAt: 2
    } } })
    expect(useStore.getState().streamId).toBeUndefined()
    expect(useStore.getState().streamOwners).toEqual({})
    await vi.waitFor(() => expect(bridge.api.updateConversation).toHaveBeenCalled())
    const saved = bridge.api.updateConversation.mock.calls[0]!
    expect(saved[0]).toBe('a')
    expect(saved[1].messages.map((message: { id: string; role: string }) => [message.id, message.role])).toEqual([['m1', 'user'], [expect.any(String), 'assistant']])
  })

  it('keeps following it while the person looks at another task', async () => {
    emit(sent())
    await useStore.getState().openConversation('b')
    emit({ streamId: 's1', kind: 'stream', sequence: 2, conversationId: 'a', event: { type: 'text_delta', text: 'Still working.' } })
    expect(useStore.getState().activeConversation?.id).toBe('b')
    expect(useStore.getState().liveMessages).toEqual([])
    await useStore.getState().openConversation('a')
    expect(useStore.getState().liveMessages.at(-1)!.text).toBe('Still working.')
  })

  it('takes a task that is not the open one while the window still holds its state', async () => {
    await useStore.getState().openConversation('b')
    emit(sent())
    await useStore.getState().openConversation('a')
    expect(useStore.getState().liveMessages.map((message) => message.id)).toEqual(['m1', expect.any(String)])
    expect(useStore.getState().streamId).toBe('s1')
  })

  it('ignores a turn it is already following, one for a task the window never opened, and one that names no task', () => {
    emit(sent())
    emit(sent({ messageId: 'm2' }))
    emit(sent({ streamId: 's2', conversationId: 'never-opened', messageId: 'm3' }))
    emit(sent({ streamId: 's3', conversationId: undefined, messageId: 'm4' }))
    expect(useStore.getState().liveMessages.map((message) => message.id)).toEqual(['m1', expect.any(String)])
    expect(useStore.getState().streamOwners).toEqual({ s1: 'a' })
  })

  it('does not start a second answer while one is streaming', () => {
    emit(sent())
    emit(sent({ streamId: 's9', messageId: 'm9' }))
    expect(useStore.getState().liveMessages).toHaveLength(2)
    expect(useStore.getState().streamId).toBe('s1')
  })
})
