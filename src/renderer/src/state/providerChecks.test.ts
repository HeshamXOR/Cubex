import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ValidationResult } from '@core/types'
import type { ModelRefreshResult } from '../../../shared/ipc'

const bridge = vi.hoisted(() => ({ api: { testProvider: vi.fn(), refreshModels: vi.fn() } }))
vi.mock('../lib/api', () => ({ api: bridge.api }))
import { useProviderChecks } from './providerChecks'

const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const checks = (): ReturnType<typeof useProviderChecks.getState> => useProviderChecks.getState()

beforeEach(() => {
  vi.clearAllMocks()
  useProviderChecks.setState({ tests: {}, notices: {}, testing: {}, refreshing: {} })
})

describe('connection tests', () => {
  it('marks the provider as testing, then keeps the result as both its state and its note', async () => {
    const pending = deferred<ValidationResult>()
    bridge.api.testProvider.mockReturnValue(pending.promise)
    const run = checks().test('p1')
    expect(checks().testing.p1).toBe(true)
    pending.resolve({ ok: true, details: { models: 3 } })
    await expect(run).resolves.toMatchObject({ ok: true })
    expect(checks().testing.p1).toBeUndefined()
    expect(checks().tests.p1).toMatchObject({ ok: true })
    expect(checks().notices.p1).toMatchObject({ kind: 'test', result: { ok: true } })
  })

  it('clears the previous answer when a new test starts, so an old result never sits next to a running test', () => {
    useProviderChecks.setState({ tests: { p1: { ok: false, message: 'old' } }, notices: { p1: { kind: 'test', result: { ok: false, message: 'old' } } } })
    bridge.api.testProvider.mockReturnValue(new Promise(() => undefined))
    void checks().test('p1')
    expect(checks().tests.p1).toBeUndefined()
    expect(checks().notices.p1).toBeUndefined()
  })

  it('runs one test at a time per provider', async () => {
    bridge.api.testProvider.mockReturnValue(new Promise(() => undefined))
    void checks().test('p1')
    await expect(checks().test('p1')).resolves.toBeUndefined()
    expect(bridge.api.testProvider).toHaveBeenCalledTimes(1)
  })

  it('turns a thrown error into a failed result without the error class in front', async () => {
    bridge.api.testProvider.mockRejectedValue(new Error('Error: Provider not found.'))
    const result = await checks().test('p1')
    expect(result).toEqual({ ok: false, message: 'Provider not found.' })
    expect(checks().tests.p1).toEqual({ ok: false, message: 'Provider not found.' })
  })

  it('drops an answer that arrives after the provider was edited or removed', async () => {
    const pending = deferred<ValidationResult>()
    bridge.api.testProvider.mockReturnValue(pending.promise)
    const run = checks().test('p1')
    checks().forget('p1')
    pending.resolve({ ok: true })
    await expect(run).resolves.toBeUndefined()
    expect(checks().tests.p1).toBeUndefined()
    expect(checks().notices.p1).toBeUndefined()
    expect(checks().testing.p1).toBeUndefined()
  })

  it('keeps providers apart', async () => {
    bridge.api.testProvider.mockImplementation(async (id: string) => ({ ok: id === 'a' }))
    await Promise.all([checks().test('a'), checks().test('b')])
    expect(checks().tests.a?.ok).toBe(true)
    expect(checks().tests.b?.ok).toBe(false)
  })
})

describe('model refreshes', () => {
  it('replaces the note with the refresh outcome but leaves the last test as the row state', async () => {
    useProviderChecks.setState({ tests: { p1: { ok: true } }, notices: { p1: { kind: 'test', result: { ok: true } } } })
    const outcome: ModelRefreshResult = { ok: true, count: 12 }
    bridge.api.refreshModels.mockResolvedValue(outcome)
    await expect(checks().refresh('p1')).resolves.toEqual(outcome)
    expect(checks().notices.p1).toEqual({ kind: 'refresh', refresh: outcome })
    expect(checks().tests.p1).toEqual({ ok: true })
    expect(checks().refreshing.p1).toBeUndefined()
  })

  it('reports a failed call as a failed refresh that knows no models', async () => {
    bridge.api.refreshModels.mockRejectedValue(new Error('Error: Invalid provider id.'))
    await expect(checks().refresh('p1')).resolves.toEqual({ ok: false, count: 0, message: 'Invalid provider id.' })
  })

  it('does not start a second refresh while one is running', async () => {
    bridge.api.refreshModels.mockReturnValue(new Promise(() => undefined))
    void checks().refresh('p1')
    await expect(checks().refresh('p1')).resolves.toBeUndefined()
    expect(bridge.api.refreshModels).toHaveBeenCalledTimes(1)
  })
})

describe('dismissing and forgetting', () => {
  it('dismissing removes the note but keeps the state it produced', () => {
    useProviderChecks.setState({ tests: { p1: { ok: false, message: 'x' } }, notices: { p1: { kind: 'test', result: { ok: false, message: 'x' } } } })
    checks().dismiss('p1')
    expect(checks().notices.p1).toBeUndefined()
    expect(checks().tests.p1).toBeDefined()
  })

  it('forgetting removes everything known about the provider', () => {
    useProviderChecks.setState({ tests: { p1: { ok: true } }, notices: { p1: { kind: 'test', result: { ok: true } } }, testing: { p1: true }, refreshing: { p1: true } })
    checks().forget('p1')
    expect(checks()).toMatchObject({ tests: {}, notices: {}, testing: {}, refreshing: {} })
  })
})
