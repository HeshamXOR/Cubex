import { describe, expect, it, vi } from 'vitest'
import { AIGateway } from './AIGateway'
import { MockAIProvider } from '../providers/mock/MockAIProvider'
import { userMessage } from '../builders'
import { DEFAULT_RETRY_POLICY } from '../types/retry'
import type { AIProvider } from '../types/provider'
import type { GatewayEvent, RoutingPolicy } from '../types/routing'
import type { AIRequest } from '../types/request'
import type { AIResponse } from '../types/response'
import type { AIStreamEvent } from '../types/stream'
import { NormalizedAIError } from '../types/errors'

const req: AIRequest = { model: 'mock-large', messages: [userMessage('hi')] }

function policy(overrides: Partial<RoutingPolicy> = {}): RoutingPolicy {
  return {
    primary: { providerId: 'primary', model: 'mock-large' },
    fallbacks: [{ providerId: 'backup', model: 'mock-large' }],
    fallbackEnabled: false,
    retry: { ...DEFAULT_RETRY_POLICY, maxAttempts: 3 },
    timeout: {},
    ...overrides
  }
}

function gatewayWith(providers: Record<string, AIProvider>): AIGateway {
  return new AIGateway((id) => providers[id])
}

const fastRetry = { retryHooks: { sleep: () => Promise.resolve(), rand: () => 0.5 } }

describe('AIGateway.send', () => {

  it('retries a transient failure then succeeds', async () => {
    const p = new MockAIProvider({ id: 'primary', scenario: 'fail_then_succeed', failuresBeforeSuccess: 2, reply: 'ok now' })
    const gw = gatewayWith({ primary: p })
    const events: GatewayEvent[] = []
    const res = await gw.send(req, policy(), { ...fastRetry, onEvent: (e) => events.push(e) })
    expect(res.text).toBe('ok now')
    const attempts = events.filter((e) => e.type === 'attempt_start').length
    expect(attempts).toBe(3)
  })

  it('does NOT retry a permanent (auth) error', async () => {
    const p = new MockAIProvider({ id: 'primary', scenario: 'auth_error' })
    const spy = vi.spyOn(p, 'streamMessage')
    const gw = gatewayWith({ primary: p })
    await expect(gw.send(req, policy(), fastRetry)).rejects.toMatchObject({ category: 'AUTHENTICATION_ERROR' })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('falls back to the backup provider when enabled', async () => {
    const primary = new MockAIProvider({ id: 'primary', scenario: 'server_error' })
    const backup = new MockAIProvider({ id: 'backup', reply: 'from backup' })
    const gw = gatewayWith({ primary, backup })
    const events: GatewayEvent[] = []
    const res = await gw.send(req, policy({ fallbackEnabled: true }), { ...fastRetry, onEvent: (e) => events.push(e) })
    expect(res.text).toBe('from backup')
    expect(res.provider).toBe('backup')
    expect(events.some((e) => e.type === 'fallback')).toBe(true)
  })
})

describe('AIGateway.stream', () => {
  async function collectStream(
    gw: AIGateway,
    p: RoutingPolicy,
    opts: { signal?: AbortSignal; onEvent?: (e: GatewayEvent) => void } = {}
  ): Promise<import('../types/stream').AIStreamEvent[]> {
    const out: import('../types/stream').AIStreamEvent[] = []
    for await (const e of gw.stream(req, p, { ...fastRetry, ...opts })) out.push(e)
    return out
  }

  it('preserves a completion-only response with tool calls, usage and content exactly once', async () => {
    const response: AIResponse = {
      id: 'adapter-response', provider: 'primary', model: 'mock-large', createdAt: 123,
      text: 'Inspect this file.', stopReason: 'tool_use',
      toolCalls: [{ id: 'read-one', name: 'read_file', input: { path: 'README.md' } }],
      content: [
        { type: 'text', text: 'Inspect this file.' },
        { type: 'tool_use', id: 'read-one', name: 'read_file', input: { path: 'README.md' } }
      ],
      usage: { inputTokens: 1024, outputTokens: 12, cachedInputTokens: 512 },
      requestId: 'request-from-adapter'
    }
    let closed = false
    let consumedAfterCompletion = false
    const primary = { id: 'primary', async *streamMessage(): AsyncGenerator<AIStreamEvent> {
      try {
        yield { type: 'completed', response }
        consumedAfterCompletion = true
        yield { type: 'text_delta', text: 'Unexpected late content' }
      } finally { closed = true }
    } } as unknown as AIProvider
    const events = await collectStream(gatewayWith({ primary }), policy())
    expect(events).toEqual([{ type: 'completed', response }])
    expect(events[0]?.type === 'completed' && events[0].response).toBe(response)
    expect(consumedAfterCompletion).toBe(false)
    expect(closed).toBe(true)
  })

  it('retries before first token on transient error', async () => {
    const p = new MockAIProvider({ id: 'primary', scenario: 'fail_then_succeed', failuresBeforeSuccess: 1, reply: 'recovered stream' })
    const gw = gatewayWith({ primary: p })
    const events = await collectStream(gw, policy())
    const text = events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text).join('')
    expect(text).toBe('recovered stream')
  })

  it.each([
    { type: 'text_delta', text: 'Preparing the plan.' },
    { type: 'reasoning_delta', text: 'Checking the plan constraints.' },
    { type: 'tool_call_delta', index: 0, id: 'plan-1', name: 'exit_plan_mode' },
    { type: 'tool_call_delta', index: 0, argsDelta: '{"plan":' }
  ] as AIStreamEvent[])('does not retry, fall back or report success after partial output: %j', async (delta) => {
    const error = new NormalizedAIError({ provider: 'primary', category: 'SERVER_ERROR', classification: 'transient', retryable: true, message: 'Interrupted while preparing the plan' })
    const streamMessage = vi.fn(async function* (): AsyncGenerator<AIStreamEvent> {
      yield delta
      throw error
    })
    const primary = { id: 'primary', streamMessage } as unknown as AIProvider
    const backup = new MockAIProvider({ id: 'backup', reply: 'must not run' })
    const backupStream = vi.spyOn(backup, 'streamMessage')
    const gatewayEvents: GatewayEvent[] = []
    const events = await collectStream(gatewayWith({ primary, backup }), policy({ fallbackEnabled: true }), { onEvent: (event) => { gatewayEvents.push(event) } })
    expect(events).toEqual([delta, { type: 'error', error }])
    expect(streamMessage).toHaveBeenCalledOnce()
    expect(backupStream).not.toHaveBeenCalled()
    expect(gatewayEvents.filter((event) => event.type === 'retry_wait' || event.type === 'fallback')).toEqual([])
    expect(gatewayEvents).toContainEqual({ type: 'attempt_error', target: policy().primary, attempt: 1, error, willRetry: false })
    expect(gatewayEvents.at(-1)).toMatchObject({ type: 'final', success: false })
  })

  it('falls back on stream failure when enabled', async () => {
    const primary = new MockAIProvider({ id: 'primary', scenario: 'server_error' })
    const backup = new MockAIProvider({ id: 'backup', reply: 'backup stream' })
    const gw = gatewayWith({ primary, backup })
    const gatewayEvents: GatewayEvent[] = []
    const events = await collectStream(gw, policy({ fallbackEnabled: true }), {
      onEvent: (e) => gatewayEvents.push(e)
    })
    expect(gatewayEvents.some((e) => e.type === 'fallback')).toBe(true)
    const text = events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text).join('')
    expect(text).toBe('backup stream')
  })

  it('emits an error event when all targets fail', async () => {
    const gw = gatewayWith({ primary: new MockAIProvider({ id: 'primary', scenario: 'server_error' }) })
    const events = await collectStream(gw, policy())
    expect(events.some((e) => e.type === 'error')).toBe(true)
  })

  it('stops when aborted', async () => {
    const controller = new AbortController()
    const gw = gatewayWith({ primary: new MockAIProvider({ id: 'primary', reply: 'a b c d e f g h', chunkSize: 1, chunkDelayMs: 20 }) })
    const out: string[] = []
    const iter = gw.stream(req, policy(), { ...fastRetry, signal: controller.signal })
    for await (const e of iter) {
      if (e.type === 'text_delta') {
        out.push(e.text)
        if (out.length === 2) controller.abort()
      }
      if (e.type === 'error') {
        expect(e.error.category).toBe('CANCELLED')
      }
    }
    expect(out.length).toBeLessThan(8)
  })
})
