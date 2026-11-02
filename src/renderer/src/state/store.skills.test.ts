import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent, ChatStartRequest, Conversation, SkillSummary } from '../../../shared/ipc'
import { DEFAULT_SETTINGS } from '../../../shared/settings'
import type { ProviderConfig } from '@core/types'

const bridge = vi.hoisted(() => ({
  listeners: new Set<(event: ChatEvent) => void>(),
  api: {
    startChat: vi.fn(), cancelChat: vi.fn(), onChatEvent: vi.fn(), listPlans: vi.fn(), listSkills: vi.fn(),
    getConversation: vi.fn(), listConversations: vi.fn(), updateConversation: vi.fn(), createConversation: vi.fn(),
    listModels: vi.fn(), listProviders: vi.fn(), getSettings: vi.fn(), updateSettings: vi.fn(), compactConversation: vi.fn()
  }
}))
vi.mock('../lib/api', () => ({ api: bridge.api }))
import { useStore } from './store'
import { useQueue } from './queue'
import { skillCatalogKey, useSkills } from './skills'

const provider: ProviderConfig = { id: 'mock', kind: 'mock', name: 'Mock', accessType: 'api', auth: { type: 'none' }, enabled: true }
const conversation = (id: string, overrides: Partial<Conversation> = {}): Conversation =>
  ({ id, title: `Task ${id}`, createdAt: 1, updatedAt: 1, execution: 'cloud', workspacePath: `/work/${id}`, messages: [], ...overrides })
const skill = (name: string, source: SkillSummary['source'] = 'bundled'): SkillSummary =>
  ({ name, description: `${name} guidance`, source, path: `C:\\skills\\${name}\\SKILL.md` })
const emit = (event: ChatEvent): void => { for (const listener of [...bridge.listeners]) listener(event) }

const live = () => useStore.getState()
/** The model's answer arrives, so the next message can be sent. */
const finishTurn = (): void => emit({ streamId: live().streamId!, kind: 'stream', event: { type: 'completed', response: { id: 'r', provider: 'mock', model: 'mock-1', text: 'ok', content: [{ type: 'text', text: 'ok' }], toolCalls: [], stopReason: 'stop', createdAt: 2 } } })
const requests = (): ChatStartRequest[] => bridge.api.startChat.mock.calls.map(([request]) => request as ChatStartRequest)
const typed = (): string[] => live().liveMessages.filter((m) => m.role === 'user').map((m) => m.text)
const refusal = 'Could not load the "nope" skill: no skill with that name is available in this task. Type / in the message box to see the ones you can use.'

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
  bridge.api.listSkills.mockResolvedValue([skill('code-review'), skill('title'), skill('Frontend-Engineering'), skill('release-notes', 'cubex')])
  bridge.api.getConversation.mockImplementation(async (id: string) => conversation(id))
  bridge.api.listConversations.mockResolvedValue([])
  bridge.api.updateConversation.mockResolvedValue(undefined)
  bridge.api.createConversation.mockImplementation(async (partial: Partial<Conversation>) => conversation('new', { workspacePath: undefined, ...partial }))
  bridge.api.listModels.mockResolvedValue([])
  bridge.api.listProviders.mockResolvedValue([provider])
  bridge.api.getSettings.mockResolvedValue(DEFAULT_SETTINGS)
  useQueue.setState({ queues: {} })
  useSkills.setState({ lists: {}, loading: {}, failures: {} })
  useStore.setState(useStore.getInitialState(), true)
  useStore.setState({ activeConversation: conversation('a'), activeTabId: 'a', providers: [provider], activeProviderId: 'mock', activeModel: 'mock-1', settings: DEFAULT_SETTINGS })
  useStore.getState()._initChatEvents()
})

describe('sending a message that names a skill', () => {
  it('applies the skill to the turn and keeps what was typed as the message', async () => {
    await live().sendMessage('/code-review check the diff in src/upload')
    expect(requests()).toHaveLength(1)
    expect(requests()[0]).toMatchObject({ conversationId: 'a', userText: 'check the diff in src/upload', skill: 'code-review' })
    expect(typed()).toEqual(['/code-review check the diff in src/upload'])
  })

  it('leaves a word that is no skill as an ordinary message, exactly as it was typed', async () => {
    await live().sendMessage('/unknown-thing do it')
    expect(requests()[0]).toMatchObject({ userText: '/unknown-thing do it' })
    expect(requests()[0]).not.toHaveProperty('skill')
    expect(typed()).toEqual(['/unknown-thing do it'])
  })

  it('lets a command run as a command when a skill has the same name', async () => {
    live().setComposerText('/title Plan the upload work')
    await live().submitComposer()
    expect(bridge.api.startChat).not.toHaveBeenCalled()
    expect(bridge.api.updateConversation).toHaveBeenCalledWith('a', { title: 'Plan the upload work' })
    live().setComposerText('/skill:title Plan the upload work')
    await live().submitComposer()
    expect(requests()[0]).toMatchObject({ skill: 'title' })
  })

  it('sends a skill message that waited in the queue with the skill applied', async () => {
    await live().sendMessage('first')
    expect(useQueue.getState().add('a', { text: '/code-review second', attachments: [] })).toBe(true)
    finishTurn()
    await vi.waitFor(() => expect(requests()).toHaveLength(2))
    expect(requests()[1]).toMatchObject({ skill: 'code-review', userText: 'second' })
    expect(typed()).toEqual(['first', '/code-review second'])
  })
})

describe('a skill that cannot be applied', () => {
  beforeEach(() => {
    bridge.api.startChat.mockImplementation(async (request: ChatStartRequest) => {
      if (request.skill === 'nope') throw new Error(refusal)
      return { streamId: request.streamId }
    })
  })

  it('takes the turn back, keeps the typed words in the composer and says why', async () => {
    live().setComposerText('/skill:nope tidy the changelog')
    const before = { status: live().status, messages: live().liveMessages }
    await live().submitComposer()
    expect(live().liveMessages).toEqual(before.messages)
    expect(live().status).toBe(before.status)
    expect(live().streamId).toBeUndefined()
    expect(live().startingRequest).toBe(false)
    expect(live().streamOwners).toEqual({})
    expect(live().composerText).toBe('/skill:nope tidy the changelog')
    expect(useSkills.getState().failures).toEqual({ a: refusal })
    // Nothing was saved: the conversation holds what it held before.
    expect(bridge.api.updateConversation).not.toHaveBeenCalled()
  })

  it('reads the skills again, since the list may be what was wrong', async () => {
    await live().sendMessage('/skill:nope hi')
    await vi.waitFor(() => expect(bridge.api.listSkills).toHaveBeenCalledTimes(2))
  })

  it('answers false so a queue keeps the message, and lets the next try go through', async () => {
    expect(await live().sendMessage('/skill:nope hi')).toBe(false)
    expect(await live().sendMessage('/code-review the diff')).toBe(true)
    expect(useSkills.getState().failures).toEqual({})
    expect(typed()).toEqual(['/code-review the diff'])
  })

})

describe('the skills of a task', () => {
  it('keeps one list for each task and project folder, and shares a request that is already on its way', async () => {
    let finish: (skills: SkillSummary[]) => void = () => undefined
    bridge.api.listSkills.mockImplementationOnce(() => new Promise<SkillSummary[]>((resolve) => { finish = resolve }))
    const first = useSkills.getState().load('a', '/work/a')
    const second = useSkills.getState().load('a', '/work/a')
    expect(useSkills.getState().loading[skillCatalogKey('a', '/work/a')]).toBe(true)
    finish([skill('debugging')])
    expect(await first).toEqual(await second)
    expect(bridge.api.listSkills).toHaveBeenCalledTimes(1)
    expect(useSkills.getState().loading).toEqual({})

    await useSkills.getState().ensure('a', '/work/a')
    expect(bridge.api.listSkills).toHaveBeenCalledTimes(1)
    await useSkills.getState().ensure('a', '/work/elsewhere')
    expect(bridge.api.listSkills).toHaveBeenCalledTimes(2)
  })

  it('keeps the list it has when a refresh fails, and says nothing is known when there never was one', async () => {
    await useSkills.getState().load('a', '/work/a')
    bridge.api.listSkills.mockRejectedValueOnce(new Error('Task was not found.'))
    expect((await useSkills.getState().load('a', '/work/a'))?.map((entry) => entry.name)).toContain('code-review')
    bridge.api.listSkills.mockRejectedValueOnce(new Error('Task was not found.'))
    expect(await useSkills.getState().load('b', '/work/b')).toBeUndefined()
    expect(useSkills.getState().lists[skillCatalogKey('b', '/work/b')]).toBeUndefined()
  })

})
