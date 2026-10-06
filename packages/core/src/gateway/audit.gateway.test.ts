import { describe, expect, it } from 'vitest'
import { AIGateway } from './AIGateway'
import { NormalizedAIError } from '../types/errors'
import { DEFAULT_RETRY_POLICY } from '../types'
import type { AIProvider, AIStreamEvent, RoutingPolicy } from '../types'
import { AnthropicProvider } from '../providers/anthropic'
import { StreamAccumulator } from '../streaming/accumulator'
import { toAnthBlocks } from '../providers/anthropic/translate'
import { parseXmlToolCalls, stripCodeForToolParsing } from '../tools/xmlToolCalls'

const rateLimited = (): NormalizedAIError => new NormalizedAIError({
  provider: 'p', category: 'RATE_LIMIT_ERROR', message: '429', classification: 'transient', retryable: true, statusCode: 429
})

function gatewayFor(stream: () => AsyncGenerator<AIStreamEvent>): AIGateway {
  const provider = { id: 'p', streamMessage: stream } as unknown as AIProvider
  return new AIGateway(() => provider)
}
const policy = (retry: Partial<RoutingPolicy['retry']>): RoutingPolicy => ({
  primary: { providerId: 'p', model: 'm' }, fallbacks: [], fallbackEnabled: false,
  retry: { ...DEFAULT_RETRY_POLICY, ...retry }, timeout: {}
})

describe('gateway audit regressions', () => {
  it('honours retryOn429=false for streaming requests (same rules as send())', async () => {
    let attempts = 0
    const gateway = gatewayFor(async function* () { attempts++; throw rateLimited() })
    const events: AIStreamEvent[] = []
    for await (const ev of gateway.stream({ model: 'm', messages: [] }, policy({ retryOn429: false, maxAttempts: 3 }), { retryHooks: { sleep: async () => {} } })) events.push(ev)
    expect(attempts).toBe(1)
  })

  it('reports a cancel during the retry back-off as CANCELLED, not as an unknown error', async () => {
    const controller = new AbortController()
    const gateway = gatewayFor(async function* () { throw rateLimited() })
    const events: AIStreamEvent[] = []
    let thrown: unknown
    try {
      const iterator = gateway.stream({ model: 'm', messages: [] }, policy({ maxAttempts: 3, initialDelayMs: 5_000, jitter: 'none' }), { signal: controller.signal })
      setTimeout(() => controller.abort(), 20)
      for await (const ev of iterator) events.push(ev)
    } catch (error) { thrown = error }
    expect(thrown).toBeUndefined()
    const error = events.find((ev) => ev.type === 'error') as Extract<AIStreamEvent, { type: 'error' }> | undefined
    expect(error?.error.category).toBe('CANCELLED')
  })

  it('disables the Anthropic SDK internal retries so the gateway policy is the only retry layer', () => {
    const provider = new AnthropicProvider({ id: 'a', name: 'A', kind: 'anthropic', auth: { type: 'api_key' }, enabled: true } as never, 'k')
    expect((provider as unknown as { client: { maxRetries: number } }).client.maxRetries).toBe(0)
  })

  it('keeps signed thinking blocks so the tool loop can replay them to Anthropic', () => {
    const acc = new StreamAccumulator('a', 'm')
    acc.push({ type: 'reasoning_delta', text: 'think' })
    acc.push({ type: 'metadata', data: { reasoningBlock: { signature: 'sig-1' } } })
    acc.push({ type: 'tool_call_delta', index: 0, id: 't', name: 'read_file', argsDelta: '{}' })
    const response = acc.finalize()
    expect(response.content[0]).toEqual({ type: 'reasoning', text: 'think', signature: 'sig-1' })
    expect(toAnthBlocks(response.content)[0]).toEqual({ type: 'thinking', thinking: 'think', signature: 'sig-1' })
  })

  it('does not treat <invoke> markup inside code fences or inline code as tool calls', () => {
    const quoted = 'Example:\n```xml\n<invoke name="run_command"><parameter name="command">rm -rf x</parameter></invoke>\n```\nand `<invoke name="a"></invoke>`'
    expect(parseXmlToolCalls(stripCodeForToolParsing(quoted))).toEqual([])
    const real = 'Reading now.\n<invoke name="read_file"><parameter name="path">a.ts</parameter></invoke>'
    expect(parseXmlToolCalls(stripCodeForToolParsing(real))).toHaveLength(1)
  })
})
