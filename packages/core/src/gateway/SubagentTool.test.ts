import { describe, expect, it } from 'vitest'
import { AIGateway } from './AIGateway'
import { createSubagentTool } from './SubagentTool'
import { MockAIProvider } from '../providers/mock/MockAIProvider'
import { DEFAULT_RETRY_POLICY } from '../types/retry'
import type { RoutingPolicy } from '../types/routing'
import type { ToolExecutionContext } from '../types/tools'

const policy: RoutingPolicy = {
  primary: { providerId: 'p', model: 'mock-large' },
  fallbacks: [],
  fallbackEnabled: false,
  retry: { ...DEFAULT_RETRY_POLICY, enabled: false },
  timeout: {}
}

const ctx: ToolExecutionContext = { requestPermission: async () => ({ decision: 'allow' }) }

describe('createSubagentTool', () => {
  it('delegates a task and returns the subagent result text', async () => {
    const gw = new AIGateway(() => new MockAIProvider({ id: 'p', reply: 'subagent answer' }))
    const tool = createSubagentTool(gw, policy)
    const result = await tool.execute({ task: 'summarize X' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.content).toBe('subagent answer')
  })

  it('errors when task is missing', async () => {
    const gw = new AIGateway(() => new MockAIProvider({ id: 'p' }))
    const tool = createSubagentTool(gw, policy)
    const result = await tool.execute({}, ctx)
    expect(result.isError).toBe(true)
  })

  it('surfaces a subagent failure as an error result', async () => {
    const gw = new AIGateway(() => new MockAIProvider({ id: 'p', scenario: 'auth_error' }))
    const tool = createSubagentTool(gw, policy)
    const result = await tool.execute({ task: 'do a thing' }, ctx)
    expect(result.isError).toBe(true)
    expect(String(result.content)).toMatch(/subagent failed/i)
  })

  it('runs on a cheaper target model when configured', async () => {
    const providers: Record<string, MockAIProvider> = {
      big: new MockAIProvider({ id: 'big', reply: 'from big' }),
      small: new MockAIProvider({ id: 'small', reply: 'from small' })
    }
    const gw = new AIGateway((id) => providers[id])
    const tool = createSubagentTool(gw, { ...policy, primary: { providerId: 'big', model: 'x' } }, {
      target: { providerId: 'small', model: 'mini' }
    })
    const result = await tool.execute({ task: 'cheap task' }, ctx)
    expect(result.content).toBe('from small')
  })
})
