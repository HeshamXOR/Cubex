import { afterEach, describe, expect, it, vi } from 'vitest'
import { withTimeout } from './timeout'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('withTimeout cleanup', () => {
  it('removes the external abort listener and timer when a request ends', () => {
    vi.useFakeTimers()
    const external = new AbortController()
    const add = vi.spyOn(external.signal, 'addEventListener')
    const remove = vi.spyOn(external.signal, 'removeEventListener')
    const { signal, clear } = withTimeout({ totalMs: 1_000 }, external.signal)

    expect(vi.getTimerCount()).toBe(1)
    const listener = add.mock.calls[0]?.[1]
    expect(listener).toBeTypeOf('function')
    clear()
    clear()

    expect(remove).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith('abort', listener)
    expect(vi.getTimerCount()).toBe(0)
    external.abort(new Error('Later cancellation'))
    vi.advanceTimersByTime(2_000)
    expect(signal.aborted).toBe(false)
  })

  it('forwards external cancellation with its reason while active', () => {
    vi.useFakeTimers()
    const external = new AbortController()
    const { signal, clear } = withTimeout({ requestMs: 1_000 }, external.signal)
    const reason = new Error('User cancelled')

    external.abort(reason)
    expect(signal.aborted).toBe(true)
    expect(signal.reason).toBe(reason)
    clear()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps timeout cancellation active until cleanup', () => {
    vi.useFakeTimers()
    const external = new AbortController()
    const remove = vi.spyOn(external.signal, 'removeEventListener')
    const { signal, clear } = withTimeout({ totalMs: 1_000 }, external.signal)

    vi.advanceTimersByTime(1_000)
    expect(signal.aborted).toBe(true)
    expect(signal.reason).toMatchObject({ name: 'TimeoutError' })
    clear()
    expect(remove).toHaveBeenCalledOnce()
  })

  it('uses an already aborted signal without attaching a listener', () => {
    const external = new AbortController()
    const reason = new Error('Already cancelled')
    external.abort(reason)
    const add = vi.spyOn(external.signal, 'addEventListener')
    const { signal, clear } = withTimeout(undefined, external.signal)

    expect(signal.reason).toBe(reason)
    expect(add).not.toHaveBeenCalled()
    clear()
  })
})
