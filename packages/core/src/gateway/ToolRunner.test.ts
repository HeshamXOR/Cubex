import { describe, expect, it, vi } from 'vitest'
import { AIGateway } from './AIGateway'
import { ToolRunner, toolRegistry } from './ToolRunner'
import { MockAIProvider } from '../providers/mock/MockAIProvider'
import { userMessage } from '../builders'
import { DEFAULT_RETRY_POLICY } from '../types/retry'
import type { RoutingPolicy } from '../types/routing'
import type { ExecutableTool, ToolExecutionContext } from '../types/tools'
import type { AIProvider } from '../types/provider'

const policy: RoutingPolicy = {
  primary: { providerId: 'p', model: 'mock-large' },
  fallbacks: [],
  fallbackEnabled: false,
  retry: { ...DEFAULT_RETRY_POLICY, enabled: false },
  timeout: {}
}

/**
 * A provider that emits a tool_call on the FIRST turn and a normal reply on the
 * second — proving the model→tool→model loop.
 */
class ToolThenTextProvider extends MockAIProvider {
  private turn = 0
  constructor() {
    super({ id: 'p' })
  }
  override async *streamMessage(request: Parameters<AIProvider['streamMessage']>[0], options?: Parameters<AIProvider['streamMessage']>[1]) {
    this.turn += 1
    if (this.turn === 1) {
      this.setScenario('tool_call')
      yield* super.streamMessage(request, options)
    } else {
      this.setScenario('normal')
      yield* new MockAIProvider({ id: 'p', reply: 'The weather in Paris is sunny.' }).streamMessage(request, options)
    }
  }
}

const weatherTool = (perm: 'allow' | 'ask' | 'deny', exec: ReturnType<typeof vi.fn>): ExecutableTool => ({
  definition: { name: 'get_weather', description: 'weather', inputSchema: { type: 'object' } },
  defaultPermission: perm,
  execute: exec
})

function ctx(decision: 'allow' | 'deny' = 'allow'): ToolExecutionContext {
  return {
    requestPermission: vi.fn(async () => ({ decision }) as never)
  }
}

describe('ToolRunner', () => {
  it('executes an allowed tool and continues the conversation', async () => {
    const provider = new ToolThenTextProvider()
    const gw = new AIGateway(() => provider)
    const exec = vi.fn(async () => ({ toolUseId: 'x', content: 'sunny, 24C' }))
    const runner = new ToolRunner(gw, toolRegistry([weatherTool('allow', exec)]))
    const result = await runner.run({ model: 'mock-large', messages: [userMessage('weather in Paris?')] }, policy, ctx())
    expect(exec).toHaveBeenCalledOnce()
    expect(result.finalResponse.text).toContain('Paris')
    expect(result.toolInvocations).toHaveLength(1)
  })

  it('requests permission for ask tools and denies when refused', async () => {
    const provider = new ToolThenTextProvider()
    const gw = new AIGateway(() => provider)
    const exec = vi.fn(async () => ({ toolUseId: 'x', content: 'should not run' }))
    const runner = new ToolRunner(gw, toolRegistry([weatherTool('ask', exec)]))
    const c = ctx('deny')
    const result = await runner.run({ model: 'mock-large', messages: [userMessage('weather?')] }, policy, c)
    expect(c.requestPermission).toHaveBeenCalledOnce()
    expect(exec).not.toHaveBeenCalled()
    expect(result.toolInvocations[0]!.result.isError).toBe(true)
  })

  it('reports an error for an unregistered tool', async () => {
    const provider = new ToolThenTextProvider()
    const gw = new AIGateway(() => provider)
    const runner = new ToolRunner(gw, toolRegistry([]))
    const result = await runner.run({ model: 'mock-large', messages: [userMessage('weather?')] }, policy, ctx())
    expect(result.toolInvocations[0]!.result.isError).toBe(true)
  })
})

describe('ToolRunner assistant turn replay', () => {
  it('sends the assistant turn back as the model produced it, thinking included', async () => {
    const call = { id: 'toolu_A', name: 'get_weather', input: { city: 'Paris' } }
    const turn = {
      id: 'r1', provider: 'p', model: 'mock-large', createdAt: 0, text: 'Checking.', toolCalls: [call], stopReason: 'tool_use' as const,
      content: [
        { type: 'reasoning' as const, text: 'need weather', signature: 'sig-A' },
        { type: 'text' as const, text: 'Checking.' },
        { type: 'tool_use' as const, ...call }
      ]
    }
    const final = { ...turn, id: 'r2', text: 'Sunny.', toolCalls: [], stopReason: 'stop' as const, content: [{ type: 'text' as const, text: 'Sunny.' }] }
    const send = vi.fn().mockResolvedValueOnce(turn).mockResolvedValueOnce(final)
    const exec = vi.fn(async () => ({ toolUseId: 'x', content: 'sunny, 24C' }))
    const runner = new ToolRunner({ send } as unknown as AIGateway, toolRegistry([weatherTool('allow', exec)]))
    await runner.run({ model: 'mock-large', messages: [userMessage('weather?')] }, policy, ctx())
    expect(send.mock.calls[1]?.[0].messages[1]).toEqual({ role: 'assistant', content: turn.content })
  })
})
