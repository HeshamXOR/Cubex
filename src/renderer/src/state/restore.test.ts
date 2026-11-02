import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, PlanAsk, RestoreResult } from '../../../shared/ipc'
import { DEFAULT_SETTINGS } from '../../../shared/settings'
import type { ProviderConfig } from '@core/types'

const bridge = vi.hoisted(() => ({
  api: {
    startChat: vi.fn(), cancelChat: vi.fn(), onChatEvent: vi.fn(), listPlans: vi.fn(), getConversation: vi.fn(),
    listConversations: vi.fn(), updateConversation: vi.fn(), listModels: vi.fn(), listProviders: vi.fn(), getSettings: vi.fn(),
    restoreCheckpoint: vi.fn(), undoRestore: vi.fn()
  },
  focusComposer: vi.fn()
}))
vi.mock('../lib/api', () => ({ api: bridge.api }))
vi.mock('../lib/composerFocus', () => ({ focusComposer: bridge.focusComposer, registerComposer: vi.fn() }))
import { useStore, type LiveMessage } from './store'
import { restoreTo, undoRestore, useRestore } from './restore'

const provider: ProviderConfig = { id: 'mock', kind: 'mock', name: 'Mock', accessType: 'api', auth: { type: 'none' }, enabled: true }
const image = { type: 'image' as const, source: { kind: 'base64' as const, mediaType: 'image/png', data: 'AAAA' } }

const conversation = (extra: Partial<Conversation> = {}): Conversation => ({
  id: 'a', title: 'Task a', createdAt: 1, updatedAt: 1, execution: 'cloud', workspacePath: 'I:\\a', messages: [], ...extra
})
const thread = (): LiveMessage[] => [
  { id: 'u1', role: 'user', text: 'first request', createdAt: 100 },
  { id: 'a1', role: 'assistant', text: 'first answer', createdAt: 150 },
  { id: 'u2', role: 'user', text: 'second request', createdAt: 200, attachments: [image] },
  { id: 'a2', role: 'assistant', text: 'second answer', createdAt: 250 },
  { id: 'u3', role: 'user', text: 'third request', createdAt: 300 },
  { id: 'a3', role: 'assistant', text: 'third answer', createdAt: 350 }
]
const plan = (id: string, createdAt: number): PlanAsk => ({ id, plan: `# ${id}`, title: id, conversationId: 'a', createdAt, status: 'approved' })

const restored = (extra: Partial<RestoreResult> = {}): RestoreResult => ({ restored: [], skipped: [], failed: [], ...extra })
const ids = (): string[] => useStore.getState().liveMessages.map((message) => message.id)

beforeEach(() => {
  vi.clearAllMocks()
  bridge.api.onChatEvent.mockReturnValue(() => undefined)
  bridge.api.listPlans.mockResolvedValue([])
  bridge.api.listConversations.mockResolvedValue([])
  bridge.api.updateConversation.mockResolvedValue(undefined)
  bridge.api.listModels.mockResolvedValue([])
  bridge.api.listProviders.mockResolvedValue([provider])
  bridge.api.getSettings.mockResolvedValue(DEFAULT_SETTINGS)
  useRestore.setState({ notices: {}, restoring: false })
  useStore.setState(useStore.getInitialState(), true)
  useStore.setState({
    activeConversation: conversation({ contextStartMessageId: 'u3', contextSummary: 'Goal: retries.', contextSummaryAt: 280 }),
    activeTabId: 'a', providers: [provider], activeProviderId: 'mock', activeModel: 'mock-1', settings: DEFAULT_SETTINGS,
    liveMessages: thread(), status: 'done',
    todos: [{ content: 'Run the tests', status: 'completed' }],
    plans: [plan('plan-old', 120), plan('plan-new', 260)], activePlan: plan('plan-new', 260), planPanelOpen: true
  })
})

describe('restoring the conversation', () => {
  it('cuts the thread back to before the message, and says what was removed', async () => {
    bridge.api.restoreCheckpoint.mockResolvedValue(restored({ conversation: { removedMessages: 4, removedPlanIds: ['plan-new'], contextCleared: true }, undoId: 'undo-1' }))
    await restoreTo('u2', { code: false, conversation: true })
    expect(bridge.api.restoreCheckpoint).toHaveBeenCalledWith('a', 'u2', { code: false, conversation: true })
    expect(ids()).toEqual(['u1', 'a1'])
    const notice = useRestore.getState().notices.a!
    expect(notice).toMatchObject({ kind: 'restored', undoId: 'undo-1', messageCount: 2, undoing: false })
    expect(notice.cut?.messages.map((message) => message.id)).toEqual(['u2', 'a2', 'u3', 'a3'])
  })

  it('puts the message back in the composer, attachments too, and focuses it', async () => {
    bridge.api.restoreCheckpoint.mockResolvedValue(restored({ conversation: { removedMessages: 4, removedPlanIds: [], contextCleared: false } }))
    await restoreTo('u2', { code: false, conversation: true })
    expect(useStore.getState().composerText).toBe('second request')
    expect(useStore.getState().attachments).toEqual([image])
    expect(bridge.focusComposer).toHaveBeenCalled()
  })

})

describe('restoring the code', () => {

  it('reports files it left alone and keeps the thread when a file could not be written', async () => {
    bridge.api.restoreCheckpoint.mockResolvedValue(restored({
      restored: ['src/a.ts'], skipped: [{ path: 'src/b.ts', reason: 'Changed outside Cubex since its last edit' }],
      failed: [{ path: 'src/c.ts', reason: 'Another program is using it' }]
    }))
    await restoreTo('u2', { code: true, conversation: true })
    expect(ids()).toHaveLength(6)
    expect(useRestore.getState().notices.a?.result?.failed).toHaveLength(1)
  })
})

describe('when a restore cannot run', () => {
  it('shows the reason main gave and changes nothing', async () => {
    bridge.api.restoreCheckpoint.mockRejectedValue(new Error('Stop the running turn before restoring an earlier point.'))
    await restoreTo('u2', { code: true, conversation: true })
    expect(useRestore.getState().notices.a).toMatchObject({ kind: 'failed', error: 'Stop the running turn before restoring an earlier point.' })
    expect(ids()).toHaveLength(6)
    expect(useRestore.getState().restoring).toBe(false)
  })

  it('does not call main while a turn is running or for a message that is not there', async () => {
    useStore.setState({ streamId: 'running' })
    await restoreTo('u2', { code: true, conversation: true })
    useStore.setState({ streamId: undefined })
    await restoreTo('nope', { code: true, conversation: true })
    expect(bridge.api.restoreCheckpoint).not.toHaveBeenCalled()
  })

  it('ignores a second request while one is in flight', async () => {
    let finish!: (result: RestoreResult) => void
    bridge.api.restoreCheckpoint.mockImplementationOnce(() => new Promise<RestoreResult>((resolve) => { finish = resolve }))
    const first = restoreTo('u2', { code: true, conversation: false })
    expect(useRestore.getState().restoring).toBe(true)
    await restoreTo('u3', { code: true, conversation: false })
    expect(bridge.api.restoreCheckpoint).toHaveBeenCalledTimes(1)
    finish(restored())
    await first
  })
})

describe('undoing a restore', () => {
  async function restoreSecondExchange(): Promise<void> {
    bridge.api.restoreCheckpoint.mockResolvedValue(restored({ restored: ['src/a.ts'], conversation: { removedMessages: 4, removedPlanIds: ['plan-new'], contextCleared: true }, undoId: 'undo-1' }))
    await restoreTo('u2', { code: true, conversation: true })
  }

  it('puts the messages and the summary back and reloads the plans', async () => {
    await restoreSecondExchange()
    bridge.api.undoRestore.mockResolvedValue({ restored: ['src/a.ts'], conversation: true })
    await undoRestore()
    expect(bridge.api.undoRestore).toHaveBeenCalledWith('a', 'undo-1')
    expect(ids()).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3'])
    expect(useStore.getState().activeConversation).toMatchObject({ contextStartMessageId: 'u3', contextSummary: 'Goal: retries.', contextSummaryAt: 280 })
    expect(bridge.api.listPlans).toHaveBeenCalledWith('a')
    expect(useRestore.getState().notices.a).toMatchObject({ kind: 'undone', undone: { files: 1, messages: 4 }, messageCount: 6 })
  })

  it('takes the message back out of the composer when it is still the one the restore put there', async () => {
    await restoreSecondExchange()
    expect(useStore.getState().composerText).toBe('second request')
    bridge.api.undoRestore.mockResolvedValue({ restored: [], conversation: true })
    await undoRestore()
    expect(useStore.getState().composerText).toBe('')
    expect(useStore.getState().attachments).toEqual([])
  })

  it('reports why it could not undo, and offers no second try', async () => {
    await restoreSecondExchange()
    bridge.api.undoRestore.mockRejectedValue(new Error('Undo stopped: these files changed after the restore. Your current files were preserved.\nsrc/a.ts'))
    await undoRestore()
    const notice = useRestore.getState().notices.a!
    expect(notice).toMatchObject({ kind: 'undo-failed', undoId: undefined, undoing: false })
    expect(notice.error).toContain('Undo stopped')
    expect(ids()).toEqual(['u1', 'a1'])
    await undoRestore()
    expect(bridge.api.undoRestore).toHaveBeenCalledTimes(1)
  })

})

