import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent } from '@shared/ipc'
import { DEFAULT_NOTIFICATIONS, type NotificationSettings } from '@shared/settings'
import type { WindowState } from './decide'
import { Notifier, SETTLE_MS, type NotifyHost, type Toast } from './Notifier'

const FRONT: WindowState = { focused: true, minimized: false, visible: true }
const BACK: WindowState = { focused: false, minimized: false, visible: true }

interface ToastRecord { toast: Toast; onClick: () => void; closed: boolean }

function setup(options: { window?: WindowState; settings?: Partial<NotificationSettings>; titles?: Record<string, string>; titleThrows?: boolean } = {}) {
  const state = { window: options.window ?? BACK, toasts: [] as ToastRecord[], flashes: [] as boolean[], badges: [] as number[], shown: 0, opened: [] as string[] }
  const host: NotifyHost = {
    windowState: () => state.window,
    show: (toast, onClick) => {
      const record: ToastRecord = { toast, onClick, closed: false }
      state.toasts.push(record)
      return { close: () => { record.closed = true } }
    },
    flash: (on) => { state.flashes.push(on) },
    badge: (count) => { state.badges.push(count) },
    showWindow: () => { state.shown++ },
    openConversation: (id) => { state.opened.push(id) }
  }
  let current: NotificationSettings = { ...DEFAULT_NOTIFICATIONS, ...options.settings }
  const titles = options.titles ?? { c1: 'Retry uploads on 429', c2: 'Fix flaky checkout test' }
  const notifier = new Notifier({
    host,
    settings: () => current,
    titleOf: (id) => {
      if (options.titleThrows) throw new Error('database is locked')
      return titles[id]
    }
  })
  return { notifier, state, change: (patch: Partial<NotificationSettings>) => { current = { ...current, ...patch } } }
}

const ev = (event: Record<string, unknown>): ChatEvent => event as unknown as ChatEvent
const at = (streamId = 's1', conversationId = 'c1') => ({ streamId, conversationId })
const permission = (title = 'Run npm test', ids = at()) => ev({ ...ids, kind: 'permission', ask: { id: 'p1', toolName: 'run_command', title } })
const question = (text = 'Which database should I use?', ids = at()) => ev({ ...ids, kind: 'question', ask: { id: 'q1', question: text, options: [] } })
const plan = (status: string | undefined, ids = at()) => ev({ ...ids, kind: 'plan', ask: { id: 'plan1', plan: '1. do it', title: 'Add retry', ...(status ? { status } : {}) } })
const tool = (name: string, title: string, phase = 'done', extra: Record<string, unknown> = {}, ids = at()) => ev({ ...ids, kind: 'tool', tool: { id: `${name}-${title}`, name, title, phase, ...extra } })
const completed = (stopReason = 'stop', ids = at()) => ev({ ...ids, kind: 'stream', event: { type: 'completed', response: { stopReason } } })
const failed = (category: string, message = 'boom', ids = at()) => ev({ ...ids, kind: 'stream', event: { type: 'error', error: { category, message, provider: 'p', classification: 'permanent', retryable: false } } })
const textDelta = (ids = at()) => ev({ ...ids, kind: 'stream', event: { type: 'text_delta', text: 'hi' } })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
})
afterEach(() => vi.useRealTimers())

describe('a finished turn', () => {
  it('shows one toast titled with the session once it has settled', () => {
    const { notifier, state } = setup()
    notifier.onChatEvent(tool('edit_file', 'Edit src/a.ts'))
    notifier.onChatEvent(tool('write_file', 'Write src/b.ts'))
    notifier.onChatEvent(tool('edit_file', 'Edit src/a.ts'))
    notifier.onChatEvent(completed())
    expect(state.toasts).toHaveLength(0)
    vi.advanceTimersByTime(SETTLE_MS)
    expect(state.toasts.map((record) => record.toast)).toEqual([{ title: 'Retry uploads on 429', body: 'Finished: 2 files changed', silent: true }])
  })

  it('does not count edits that failed, or tools that only read', () => {
    const { notifier, state } = setup()
    notifier.onChatEvent(tool('edit_file', 'Edit src/a.ts', 'error'))
    notifier.onChatEvent(tool('read_file', 'Read src/b.ts'))
    notifier.onChatEvent(completed())
    vi.advanceTimersByTime(SETTLE_MS)
    expect(state.toasts[0]?.toast.body).toBe('Finished')
  })

  it('counts every file of a patch', () => {
    const { notifier, state } = setup()
    notifier.onChatEvent(tool('apply_patch', 'Patch 3 files', 'done', { files: [{ path: 'a' }, { path: 'b' }, { path: 'c' }] }))
    notifier.onChatEvent(completed())
    vi.advanceTimersByTime(SETTLE_MS)
    expect(state.toasts[0]?.toast.body).toBe('Finished: 3 files changed')
  })

  it('keeps each stream\'s files to itself', () => {
    const { notifier, state } = setup()
    notifier.onChatEvent(tool('edit_file', 'Edit one.ts', 'done', {}, at('s1', 'c1')))
    notifier.onChatEvent(tool('edit_file', 'Edit two.ts', 'done', {}, at('s2', 'c2')))
    notifier.onChatEvent(tool('edit_file', 'Edit three.ts', 'done', {}, at('s2', 'c2')))
    notifier.onChatEvent(completed('stop', at('s1', 'c1')))
    notifier.onChatEvent(completed('stop', at('s2', 'c2')))
    vi.advanceTimersByTime(SETTLE_MS)
    expect(state.toasts.map((record) => [record.toast.title, record.toast.body])).toEqual([
      ['Retry uploads on 429', 'Finished: 1 file changed'],
      ['Fix flaky checkout test', 'Finished: 2 files changed']
    ])
  })

  it('opens the session and brings the window back when the toast is clicked', () => {
    const { notifier, state } = setup()
    notifier.onChatEvent(completed())
    vi.advanceTimersByTime(SETTLE_MS)
    state.toasts[0]!.onClick()
    expect(state.shown).toBe(1)
    expect(state.opened).toEqual(['c1'])
  })

  it('stays silent for a turn the person stopped', () => {
    const { notifier, state } = setup()
    notifier.onChatEvent(completed('cancelled'))
    notifier.onChatEvent(failed('CANCELLED', 'stopped', at('s2', 'c2')))
    vi.advanceTimersByTime(SETTLE_MS * 5)
    expect(state.toasts).toHaveLength(0)
  })

  it('names the session by the app while it still has a placeholder title', () => {
    const { notifier, state } = setup({ titles: { c1: 'New Chat' } })
    notifier.onChatEvent(completed())
    vi.advanceTimersByTime(SETTLE_MS)
    expect(state.toasts[0]?.toast.title).toBe('Cubex')
  })

  it('survives a title lookup that throws', () => {
    const { notifier, state } = setup({ titleThrows: true })
    notifier.onChatEvent(completed())
    vi.advanceTimersByTime(SETTLE_MS)
    expect(state.toasts[0]?.toast.title).toBe('Cubex')
  })
})

describe('a failed turn', () => {
  it('says why it stopped', () => {
    const { notifier, state } = setup()
    notifier.onChatEvent(failed('TIMEOUT'))
    vi.advanceTimersByTime(SETTLE_MS)
    expect(state.toasts[0]?.toast).toEqual({ title: 'Retry uploads on 429', body: 'Stopped: the provider timed out', silent: true })
  })
})

describe('where the person is', () => {
  it('says nothing about the session on screen in a window that is in front', () => {
    const { notifier, state } = setup({ window: FRONT })
    notifier.setOnScreen('c1')
    notifier.onChatEvent(completed())
    notifier.onChatEvent(permission(undefined, at('s2', 'c1')))
    vi.advanceTimersByTime(SETTLE_MS)
    expect(state.toasts).toHaveLength(0)
    expect(state.flashes).toEqual([])
    expect(state.badges).toEqual([])
  })

  it('also stays quiet about other sessions unless background-only is off', () => {
    const quiet = setup({ window: FRONT })
    quiet.notifier.setOnScreen('c2')
    quiet.notifier.onChatEvent(completed())
    vi.advanceTimersByTime(SETTLE_MS)
    expect(quiet.state.toasts).toHaveLength(0)

    const loud = setup({ window: FRONT, settings: { onlyInBackground: false } })
    loud.notifier.setOnScreen('c2')
    loud.notifier.onChatEvent(completed())
    vi.advanceTimersByTime(SETTLE_MS)
    expect(loud.state.toasts).toHaveLength(1)
  })

  it('does not tell a person who came back before the toast settled', () => {
    const { notifier, state } = setup()
    notifier.setOnScreen('c1')
    notifier.onChatEvent(completed())
    vi.advanceTimersByTime(SETTLE_MS - 100)
    state.window = FRONT
    notifier.onWindowFocus()
    vi.advanceTimersByTime(200)
    expect(state.toasts).toHaveLength(0)
  })

  it('takes down the toast of a session once the person opens it', () => {
    const { notifier, state } = setup()
    notifier.onChatEvent(completed())
    vi.advanceTimersByTime(SETTLE_MS)
    state.window = FRONT
    notifier.setOnScreen('c1')
    expect(state.toasts[0]?.closed).toBe(true)
  })

  it('leaves the toast of another session alone', () => {
    const { notifier, state } = setup()
    notifier.onChatEvent(completed())
    vi.advanceTimersByTime(SETTLE_MS)
    state.window = FRONT
    notifier.setOnScreen('c2')
    expect(state.toasts[0]?.closed).toBe(false)
  })
})

describe('a session that needs the person', () => {
  it('toasts, flashes and badges, and undoes the flash and badge once the person answers', () => {
    const { notifier, state } = setup()
    notifier.onChatEvent(tool('run_command', 'Run npm test', 'running'))
    notifier.onChatEvent(permission())
    expect(state.flashes).toEqual([true])
    expect(state.badges).toEqual([1])
    vi.advanceTimersByTime(SETTLE_MS)
    expect(state.toasts[0]?.toast).toEqual({ title: 'Retry uploads on 429', body: 'Needs your approval to run npm test', silent: true })

    notifier.onChatEvent(tool('run_command', 'Run npm test', 'done'))
    expect(state.toasts[0]?.closed).toBe(true)
    expect(state.badges).toEqual([1, 0])
    expect(state.flashes).toEqual([true, false])
  })

  it('does not show a request that was answered before its toast settled', () => {
    const { notifier, state } = setup()
    notifier.onChatEvent(permission())
    vi.advanceTimersByTime(100)
    notifier.onChatEvent(tool('run_command', 'Run npm test', 'done'))
    vi.advanceTimersByTime(SETTLE_MS)
    expect(state.toasts).toHaveLength(0)
  })

  it('counts every waiting session on the badge', () => {
    const { notifier, state } = setup()
    notifier.onChatEvent(permission('Run npm test', at('s1', 'c1')))
    notifier.onChatEvent(question('Which one?', at('s2', 'c2')))
    expect(state.badges).toEqual([1, 2])
    notifier.onChatEvent(tool('run_command', 'Run npm test', 'done', {}, at('s1', 'c1')))
    expect(state.badges).toEqual([1, 2, 1])
    expect(state.flashes).toEqual([true, true])
  })

  it('clears the flash and badge when the person returns, and puts the badge back if they leave while it still waits', () => {
    const { notifier, state } = setup()
    notifier.onChatEvent(permission())
    state.window = FRONT
    notifier.onWindowFocus()
    expect(state.flashes).toEqual([true, false])
    expect(state.badges).toEqual([1, 0])
    state.window = BACK
    notifier.onWindowBlur()
    expect(state.badges).toEqual([1, 0, 1])
  })

  it('does not badge a window that is in front', () => {
    const { notifier, state } = setup({ window: FRONT })
    notifier.setOnScreen('c9')
    notifier.onChatEvent(permission())
    expect(state.badges).toEqual([])
    state.window = BACK
    notifier.onWindowBlur()
    expect(state.badges).toEqual([1])
  })

  it('writes questions and plans the same way', () => {
    const { notifier, state } = setup()
    notifier.onChatEvent(question())
    vi.advanceTimersByTime(SETTLE_MS)
    expect(state.toasts[0]?.toast.body).toBe('Needs your answer: Which database should I use?')

    const other = setup()
    other.notifier.onChatEvent(plan(undefined))
    vi.advanceTimersByTime(SETTLE_MS)
    expect(other.state.toasts[0]?.toast.body).toBe('Needs your review: Add retry')
  })

  it('treats a resolved plan as an answer and any other progress as one too', () => {
    const resolved = setup()
    resolved.notifier.onChatEvent(plan('pending'))
    resolved.notifier.onChatEvent(plan('approved'))
    expect(resolved.state.badges).toEqual([1, 0])

    const progressed = setup()
    progressed.notifier.onChatEvent(permission())
    progressed.notifier.onChatEvent(textDelta())
    expect(progressed.state.badges).toEqual([1, 0])
  })

  it('does not take background task updates for an answer', () => {
    const { notifier, state } = setup()
    notifier.onChatEvent(permission())
    notifier.onChatEvent(ev({ ...at(), kind: 'task', task: { id: 'p_1', status: 'running' } }))
    notifier.onChatEvent(ev({ ...at(), kind: 'todos', todos: [] }))
    notifier.onChatEvent(ev({ ...at(), kind: 'review', revision: 3 }))
    expect(state.badges).toEqual([1])
    vi.advanceTimersByTime(SETTLE_MS)
    expect(state.toasts).toHaveLength(1)
  })

  it('stops waiting when the turn ends', () => {
    const { notifier, state } = setup()
    notifier.onChatEvent(permission())
    notifier.onChatEvent(completed('cancelled'))
    expect(state.badges).toEqual([1, 0])
    vi.advanceTimersByTime(SETTLE_MS * 3)
    expect(state.toasts).toHaveLength(0)
  })
})

describe('the rate limit and repeats', () => {
  it('lets one toast through per session per five seconds, replacing the earlier one in the notification center', () => {
    const { notifier, state } = setup()
    notifier.onChatEvent(completed())
    vi.advanceTimersByTime(SETTLE_MS)
    expect(state.toasts).toHaveLength(1)

    vi.advanceTimersByTime(1_600)
    notifier.onChatEvent(completed())
    vi.advanceTimersByTime(SETTLE_MS)
    expect(state.toasts).toHaveLength(1)

    vi.advanceTimersByTime(4_000)
    notifier.onChatEvent(completed())
    vi.advanceTimersByTime(SETTLE_MS)
    expect(state.toasts).toHaveLength(2)
    expect(state.toasts[0]?.closed).toBe(true)
    expect(state.toasts[1]?.closed).toBe(false)
  })

  it('limits each session on its own', () => {
    const { notifier, state } = setup()
    notifier.onChatEvent(completed('stop', at('s1', 'c1')))
    notifier.onChatEvent(completed('stop', at('s2', 'c2')))
    vi.advanceTimersByTime(SETTLE_MS)
    expect(state.toasts).toHaveLength(2)
  })

  it('holds a request back until the limit ends instead of dropping it', () => {
    const { notifier, state } = setup()
    notifier.onChatEvent(completed())
    vi.advanceTimersByTime(SETTLE_MS)
    vi.advanceTimersByTime(600)
    notifier.onChatEvent(permission())
    vi.advanceTimersByTime(SETTLE_MS)
    expect(state.toasts).toHaveLength(1)
    vi.advanceTimersByTime(4_100)
    expect(state.toasts).toHaveLength(2)
    expect(state.toasts[1]?.toast.body).toBe('Needs your approval to run npm test')
  })

  it('drops a held request that was answered meanwhile', () => {
    const { notifier, state } = setup()
    notifier.onChatEvent(completed())
    vi.advanceTimersByTime(SETTLE_MS + 600)
    notifier.onChatEvent(permission())
    vi.advanceTimersByTime(SETTLE_MS)
    notifier.onChatEvent(tool('run_command', 'Run npm test', 'done'))
    vi.advanceTimersByTime(10_000)
    expect(state.toasts).toHaveLength(1)
  })

  it('tells about the more urgent thing when two are waiting to settle', () => {
    const { notifier, state } = setup()
    notifier.onChatEvent(completed())
    vi.advanceTimersByTime(100)
    notifier.onChatEvent(permission())
    vi.advanceTimersByTime(SETTLE_MS)
    expect(state.toasts.map((record) => record.toast.body)).toEqual(['Needs your approval to run npm test'])
  })

  it('does not let a quieter one replace a more urgent one', () => {
    const { notifier, state } = setup()
    notifier.onChatEvent(failed('TIMEOUT'))
    vi.advanceTimersByTime(100)
    notifier.onChatEvent(completed())
    vi.advanceTimersByTime(SETTLE_MS)
    expect(state.toasts.map((record) => record.toast.body)).toEqual(['Stopped: the provider timed out'])
  })
})

describe('settings', () => {
  it('does nothing at all when the master switch is off', () => {
    const { notifier, state } = setup({ settings: { enabled: false } })
    notifier.onChatEvent(permission())
    notifier.onChatEvent(completed('stop', at('s2', 'c2')))
    notifier.onChatEvent(failed('TIMEOUT', 'x', at('s3', 'c3')))
    vi.advanceTimersByTime(SETTLE_MS * 4)
    expect(state.toasts).toHaveLength(0)
    expect(state.flashes).toEqual([])
    expect(state.badges).toEqual([])
  })

  it('leaves the taskbar alone for requests when that kind is off, and still reports other kinds', () => {
    const { notifier, state } = setup({ settings: { needsMe: false } })
    notifier.onChatEvent(permission())
    notifier.onChatEvent(completed('stop', at('s2', 'c2')))
    vi.advanceTimersByTime(SETTLE_MS)
    expect(state.flashes).toEqual([])
    expect(state.badges).toEqual([])
    expect(state.toasts.map((record) => record.toast.title)).toEqual(['Fix flaky checkout test'])
  })

  it('reads the settings anew for every event', () => {
    const { notifier, state, change } = setup({ settings: { finished: false } })
    notifier.onChatEvent(completed())
    vi.advanceTimersByTime(SETTLE_MS)
    expect(state.toasts).toHaveLength(0)
    change({ finished: true })
    notifier.onChatEvent(completed())
    vi.advanceTimersByTime(SETTLE_MS)
    expect(state.toasts).toHaveLength(1)
  })

  it('asks for a sound only when the setting is on', () => {
    const { notifier, state } = setup({ settings: { sound: true } })
    notifier.onChatEvent(completed())
    vi.advanceTimersByTime(SETTLE_MS)
    expect(state.toasts[0]?.toast.silent).toBe(false)
  })
})

describe('odds and ends', () => {
  it('ignores events that belong to no session', () => {
    const { notifier, state } = setup()
    notifier.onChatEvent(ev({ streamId: 's9', kind: 'stream', event: { type: 'completed', response: { stopReason: 'stop' } } }))
    vi.advanceTimersByTime(SETTLE_MS * 2)
    expect(state.toasts).toHaveLength(0)
  })

  it('cleans up the toasts, the flash and the badge on dispose', () => {
    const { notifier, state } = setup()
    notifier.onChatEvent(completed('stop', at('s1', 'c1')))
    vi.advanceTimersByTime(SETTLE_MS)
    notifier.onChatEvent(permission('Run npm test', at('s2', 'c2')))
    notifier.dispose()
    vi.advanceTimersByTime(SETTLE_MS * 3)
    expect(state.toasts).toHaveLength(1)
    expect(state.toasts[0]?.closed).toBe(true)
    expect(state.flashes.at(-1)).toBe(false)
    expect(state.badges.at(-1)).toBe(0)
  })
})
