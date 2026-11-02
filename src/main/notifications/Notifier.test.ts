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
const tool = (name: string, title: string, phase = 'done', extra: Record<string, unknown> = {}, ids = at()) => ev({ ...ids, kind: 'tool', tool: { id: `${name}-${title}`, name, title, phase, ...extra } })
const completed = (stopReason = 'stop', ids = at()) => ev({ ...ids, kind: 'stream', event: { type: 'completed', response: { stopReason } } })
const failed = (category: string, message = 'boom', ids = at()) => ev({ ...ids, kind: 'stream', event: { type: 'error', error: { category, message, provider: 'p', classification: 'permanent', retryable: false } } })

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

  it('stays silent for a turn the person stopped', () => {
    const { notifier, state } = setup()
    notifier.onChatEvent(completed('cancelled'))
    notifier.onChatEvent(failed('CANCELLED', 'stopped', at('s2', 'c2')))
    vi.advanceTimersByTime(SETTLE_MS * 5)
    expect(state.toasts).toHaveLength(0)
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
})

describe('odds and ends', () => {

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
