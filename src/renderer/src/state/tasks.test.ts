import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackgroundTask, ChatEvent } from '../../../shared/ipc'

const bridge = vi.hoisted(() => ({
  listeners: new Set<(event: ChatEvent) => void>(),
  api: { onChatEvent: vi.fn(), listTasks: vi.fn() }
}))
vi.mock('../lib/api', () => ({ api: bridge.api }))
import { useStore } from './store'
import { applyTaskEvent, syncTasks, useTasks } from './tasks'
import { runningCount } from '../lib/taskModel'

const task = (overrides: Partial<BackgroundTask> = {}): BackgroundTask => ({
  id: 'p_aaaaaa', conversationId: 'a', command: 'npm run dev', shell: 'git-bash', cwd: 'I:\\app', status: 'running', startedAt: 100, outputId: 'out-a', ...overrides
})
const emit = (event: ChatEvent): void => { for (const listener of bridge.listeners) listener(event) }
const tasksOf = (conversationId: string): BackgroundTask[] => useTasks.getState().byConversation[conversationId] ?? []

beforeEach(() => {
  vi.clearAllMocks()
  bridge.listeners.clear()
  bridge.api.onChatEvent.mockImplementation((callback: (event: ChatEvent) => void) => {
    bridge.listeners.add(callback)
    return () => bridge.listeners.delete(callback)
  })
  bridge.api.listTasks.mockResolvedValue([])
  useTasks.setState({ byConversation: {}, open: {} })
  useStore.setState(useStore.getInitialState(), true)
  useStore.getState()._initChatEvents()
})

describe('task events', () => {
  it('records a task from an event with no live stream behind it, which is how a server outlives its turn', () => {
    // Nothing owns this stream any more: the turn that started the server ended long ago.
    expect(useStore.getState().streamOwners['turn-long-over']).toBeUndefined()
    emit({ streamId: 'turn-long-over', kind: 'task', conversationId: 'a', task: task() })
    expect(tasksOf('a')).toEqual([task()])
  })

  it('follows one task through ready, stop and exit by id', () => {
    emit({ streamId: 's', kind: 'task', task: task() })
    emit({ streamId: 's', kind: 'task', task: task({ readyHint: { url: 'http://localhost:5173/', port: 5173, line: 'Local: http://localhost:5173/' } }) })
    expect(tasksOf('a')).toHaveLength(1)
    expect(tasksOf('a')[0]!.readyHint?.port).toBe(5173)

    emit({ streamId: 's', kind: 'task', task: task({ status: 'killed' }) })
    expect(tasksOf('a')[0]!).toMatchObject({ status: 'killed', readyHint: { port: 5173 } })
    emit({ streamId: 's', kind: 'task', task: task({ status: 'killed', endedAt: 900, exitCode: 1 }) })
    expect(tasksOf('a')[0]).toMatchObject({ status: 'killed', endedAt: 900 })
    expect(runningCount(tasksOf('a'))).toBe(0)
  })

  it('keeps each conversation\'s tasks apart, running first', () => {
    emit({ streamId: 's', kind: 'task', task: task({ id: 'p_done', status: 'exited', startedAt: 500 }) })
    emit({ streamId: 's', kind: 'task', task: task({ id: 'p_live', startedAt: 100 }) })
    emit({ streamId: 's', kind: 'task', task: task({ id: 'p_other', conversationId: 'b' }) })
    expect(tasksOf('a').map((entry) => entry.id)).toEqual(['p_live', 'p_done'])
    expect(tasksOf('b').map((entry) => entry.id)).toEqual(['p_other'])
    expect(runningCount(tasksOf('a'))).toBe(1)
  })

  it('does not touch the chat when a task changes', () => {
    const before = useStore.getState().liveMessages
    applyTaskEvent(task())
    expect(useStore.getState().liveMessages).toBe(before)
    expect(useStore.getState().status).toBe('idle')
  })

  it('does not let an old snapshot bring an ended task back to running', () => {
    applyTaskEvent(task({ status: 'exited', endedAt: 500, exitCode: 0 }))
    applyTaskEvent(task())
    expect(tasksOf('a')[0]!.status).toBe('exited')
  })
})

describe('reading the list', () => {
  it('adds what the main process already had running when the window opened', async () => {
    bridge.api.listTasks.mockResolvedValue([task({ id: 'p_one' }), task({ id: 'p_two', status: 'exited', startedAt: 50 })])
    await syncTasks('a')
    expect(bridge.api.listTasks).toHaveBeenCalledWith('a')
    expect(tasksOf('a').map((entry) => entry.id)).toEqual(['p_one', 'p_two'])
  })

  it('never takes a task backwards: an older list cannot undo an event that arrived while it was in flight', async () => {
    let answer!: (tasks: BackgroundTask[]) => void
    bridge.api.listTasks.mockReturnValue(new Promise<BackgroundTask[]>((resolve) => { answer = resolve }))
    const sync = syncTasks('a')
    emit({ streamId: 's', kind: 'task', task: task({ status: 'killed', endedAt: 700 }) })
    answer([task()])
    await sync
    expect(tasksOf('a')[0]).toMatchObject({ status: 'killed', endedAt: 700 })
  })

  it('keeps what it has when the list cannot be read', async () => {
    applyTaskEvent(task())
    bridge.api.listTasks.mockRejectedValue(new Error('IPC closed'))
    await expect(syncTasks('a')).resolves.toBeUndefined()
    expect(tasksOf('a')).toHaveLength(1)
  })
})

describe('open rows', () => {
  it('remembers which rows are open so they stay open while the tab is away', () => {
    useTasks.getState().setOpen('p_aaaaaa', true)
    useTasks.getState().setOpen('p_bbbbbb', false)
    expect(useTasks.getState().open).toEqual({ p_aaaaaa: true, p_bbbbbb: false })
  })
})
