import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIProvider } from './OpenAIProvider'
import { userMessage } from '../../builders'
import type { AIStreamEvent } from '../../types/stream'
import type { ProviderConfig } from '../../types/provider'

const sdk = vi.hoisted(() => ({ responses: vi.fn(), chat: vi.fn() }))
vi.mock('openai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openai')>()
  return {
    ...actual,
    default: class {
      responses = { create: sdk.responses }
      chat = { completions: { create: sdk.chat } }
    }
  }
})

function config(apiMode: 'responses' | 'chat_completions' = 'responses'): ProviderConfig {
  return { id: 'openai', kind: 'openai', name: 'OpenAI', accessType: 'api', auth: { type: 'api_key', scheme: 'bearer' }, enabled: true, apiMode }
}

afterEach(() => vi.resetAllMocks())

describe('OpenAIProvider reasoning streams', () => {
  it('forwards published Responses summaries before the answer is ready, without duplicating done events', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    sdk.responses.mockResolvedValue((async function* () {
      yield { type: 'response.created', response: { id: 'response-1' } }
      yield { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', encrypted_content: 'private-payload', summary: [] } }
      yield { type: 'response.reasoning_summary_text.delta', delta: { encrypted: 'private-payload' } }
      yield { type: 'response.reasoning_summary_text.delta', delta: 'Checking the constraints.' }
      await gate
      yield { type: 'response.reasoning_summary_text.done', text: 'Checking the constraints.' }
      yield { type: 'response.output_text.delta', delta: 'The plan is ready.' }
      yield { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 30, output_tokens: 10 } } }
    })())
    const provider = new OpenAIProvider(config(), 'fixture-key')
    const events: AIStreamEvent[] = []
    const pending = (async () => {
      for await (const event of provider.streamMessage({ model: 'gpt-6-astra', messages: [userMessage('Make a plan')] })) events.push(event)
    })()
    try {
      await vi.waitFor(() => expect(events).toContainEqual({ type: 'reasoning_delta', text: 'Checking the constraints.' }))
      expect(events.some((event) => event.type === 'text_delta' || event.type === 'stop')).toBe(false)
    } finally {
      release()
      await pending
    }
    expect(events.map((event) => event.type)).toEqual(['start', 'reasoning_delta', 'text_delta', 'usage', 'stop'])
    expect(JSON.stringify(events)).not.toContain('private-payload')
  })

  it.each(['reasoning_content', 'reasoning'])('supports %s from a compatible Chat Completions base URL', async (field) => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    sdk.chat.mockResolvedValue((async function* () {
      yield { id: 'response-2', choices: [{ delta: { [field]: 'Checking the constraints.' } }] }
      await gate
      yield { choices: [{ delta: { content: 'The plan is ready.' }, finish_reason: 'stop' }] }
    })())
    const provider = new OpenAIProvider({ ...config('chat_completions'), baseUrl: 'https://example.test/v1' }, 'fixture-key')
    const events: AIStreamEvent[] = []
    const pending = (async () => {
      for await (const event of provider.streamMessage({ model: 'reasoning-model', messages: [userMessage('Make a plan')] })) events.push(event)
    })()
    try {
      await vi.waitFor(() => expect(events).toContainEqual({ type: 'reasoning_delta', text: 'Checking the constraints.' }))
      expect(events.some((event) => event.type === 'text_delta' || event.type === 'stop')).toBe(false)
    } finally {
      release()
      await pending
    }
    expect(events).toEqual([
      { type: 'start', provider: 'openai', model: 'reasoning-model', requestId: 'response-2' },
      { type: 'reasoning_delta', text: 'Checking the constraints.' },
      { type: 'text_delta', text: 'The plan is ready.' },
      { type: 'stop', stopReason: 'stop' }
    ])
  })

  it('selects a text reasoning alias without rendering or duplicating non-text payloads', async () => {
    sdk.chat.mockResolvedValue((async function* () {
      yield { id: 'response-3', choices: [{ delta: { reasoning_content: 'One summary.', reasoning: 'One summary.' } }] }
      yield { choices: [{ delta: { reasoning_content: { encrypted: 'private-payload' }, reasoning: 'Another summary.' } }] }
      yield { choices: [{ delta: { reasoning_content: '', reasoning: '' } }] }
      yield { choices: [{ delta: { reasoning: { encrypted: 'private-payload' } } }] }
    })())
    const provider = new OpenAIProvider(config('chat_completions'), 'fixture-key')
    const events: AIStreamEvent[] = []
    for await (const event of provider.streamMessage({ model: 'reasoning-model', messages: [userMessage('Make a plan')] })) events.push(event)
    expect(events).toEqual([
      { type: 'start', provider: 'openai', model: 'reasoning-model', requestId: 'response-3' },
      { type: 'reasoning_delta', text: 'One summary.' },
      { type: 'reasoning_delta', text: 'Another summary.' }
    ])
  })
})
