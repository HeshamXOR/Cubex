import { describe, expect, it, vi } from 'vitest'
import { AIGateway } from './AIGateway'
import { createSubagentTool } from './SubagentTool'
import { MockAIProvider } from '../providers/mock/MockAIProvider'
import { DEFAULT_RETRY_POLICY } from '../types/retry'
import type { RoutingPolicy } from '../types/routing'
import type { ExecutableTool, ToolCall, ToolExecutionContext, ToolResult } from '../types/tools'
import type { AIResponse } from '../types/response'

const policy: RoutingPolicy = {
  primary: { providerId: 'p', model: 'mock-large' },
  fallbacks: [],
  fallbackEnabled: false,
  retry: { ...DEFAULT_RETRY_POLICY, enabled: false },
  timeout: {}
}

const ctx: ToolExecutionContext = { requestPermission: async () => ({ decision: 'allow' }) }

const response = (text: string, toolCalls: ToolCall[] = []): AIResponse => ({
  id: 'child-response', provider: 'p', model: 'mock-large', content: [], text, toolCalls,
  stopReason: toolCalls.length ? 'tool_use' : 'stop', createdAt: 0
})
function readonlyTool(name = 'read_file', content = 'src/parser.ts:12: export function parse() {}'): ExecutableTool {
  return { definition: { name, inputSchema: { type: 'object' } }, defaultPermission: 'allow', execute: vi.fn(async () => ({ toolUseId: '', content })) }
}

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

  it('advertises custom profiles as an "agent" enum and runs one', async () => {
    const gw = new AIGateway(() => new MockAIProvider({ id: 'p', reply: 'reviewed' }))
    const tool = createSubagentTool(gw, policy, {
      profiles: [{ name: 'reviewer', description: 'Reviews code', systemPrompt: 'You review code.' }]
    })
    const schema = tool.definition.inputSchema as { properties: { agent?: { enum?: string[] } } }
    expect(schema.properties.agent?.enum).toEqual(['reviewer'])
    expect(tool.definition.description).toMatch(/reviewer/)
    const result = await tool.execute({ task: 'review this', agent: 'reviewer' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.content).toBe('reviewed')
  })

  it('runs actual read-only tools, returns observed evidence, and reports child activity separately', async () => {
    const read = readonlyTool()
    const send = vi.fn().mockResolvedValueOnce(response('', [{ id: 'read', name: 'read_file', input: { path: 'src/parser.ts' } }]))
      .mockResolvedValueOnce(response('The parser is exported at src/parser.ts:12.'))
    const activity = vi.fn()
    const received = vi.fn()
    const tool = createSubagentTool({ send } as unknown as AIGateway, policy, { createTools: () => [read], onToolActivity: activity, onResponse: received })
    const result = await tool.execute({ task: 'Locate the parser' }, ctx)
    expect(read.execute).toHaveBeenCalledOnce()
    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('Observed tool activity:')
    expect(result.content).toContain('src/parser.ts:12: export function parse')
    expect(send.mock.calls[1]?.[0].messages.at(-1).content[0].content[0].text).toContain('export function parse')
    expect(activity.mock.calls.map(([event]) => event.phase)).toEqual(['running', 'done'])
    expect(activity.mock.calls[0]?.[0].id).toBe(activity.mock.calls[1]?.[0].id)
    expect(received).toHaveBeenCalledTimes(2)
  })

  it('does not expose mutations, shell, network or recursive delegation even if supplied as allowed tools', async () => {
    const forbidden = ['write_file', 'remove_file', 'run_command', 'web_fetch', 'delegate_to_subagent'].map((name) => readonlyTool(name))
    const send = vi.fn().mockResolvedValueOnce(response('', forbidden.map((tool, index) => ({ id: String(index), name: tool.definition.name, input: {} }))))
      .mockResolvedValueOnce(response('Those operations are unavailable.'))
    const tool = createSubagentTool({ send } as unknown as AIGateway, policy, { createTools: () => [readonlyTool(), ...forbidden] })
    const result = await tool.execute({ task: 'Inspect only' }, ctx)
    expect(send.mock.calls[0]?.[0].tools.map((value: { name: string }) => value.name)).toEqual(['read_file'])
    for (const item of forbidden) expect(item.execute).not.toHaveBeenCalled()
    expect(result.content).toContain('not available to this read-only subagent')
    expect(send.mock.calls[1]?.[0].messages.at(-1).content.every((part: { isError?: boolean }) => part.isError)).toBe(true)
  })

  it('can load skill guidance without admitting a shell or execution tool', async () => {
    const skill = readonlyTool('skill', '# Testing\nUse observable outcomes and isolated fixtures.')
    const command = readonlyTool('run_command')
    const send = vi.fn().mockResolvedValueOnce(response('', [{ id: 'guidance', name: 'skill', input: { name: 'testing' } }]))
      .mockResolvedValueOnce(response('Reviewed the test boundaries.'))
    const tool = createSubagentTool({ send } as unknown as AIGateway, policy, { createTools: () => [skill, command] })
    const result = await tool.execute({ task: 'Review the proposed tests using testing guidance.' }, ctx)
    expect(send.mock.calls[0]?.[0].tools.map((item: { name: string }) => item.name)).toEqual(['skill'])
    expect(skill.execute).toHaveBeenCalledOnce()
    expect(command.execute).not.toHaveBeenCalled()
    expect(send.mock.calls[1]?.[0].messages.at(-1).content[0].content[0].text).toContain('isolated fixtures')
    expect(result.isError).toBeFalsy()
  })

  it('caps executions and tool output, then requests a final report without tools', async () => {
    const read = readonlyTool('read_file', 'x'.repeat(30_000))
    const send = vi.fn().mockResolvedValueOnce(response('', [
      { id: 'read1', name: 'read_file', input: { path: 'one.ts' } },
      { id: 'read2', name: 'read_file', input: { path: 'two.ts' } }
    ])).mockResolvedValueOnce(response('Only the first file was inspected.'))
    const tool = createSubagentTool({ send } as unknown as AIGateway, policy, { createTools: () => [read], maxToolCalls: 1 })
    const result = await tool.execute({ task: 'Inspect files' }, ctx)
    expect(read.execute).toHaveBeenCalledOnce()
    expect(result.isError).toBe(true)
    const finalRequest = send.mock.calls[1]?.[0]
    expect(finalRequest.tools).toBeUndefined()
    expect(finalRequest.toolChoice).toBe('none')
    const parts = finalRequest.messages.find((message: { role: string }) => message.role === 'tool').content
    expect(parts[0].content[0].text).toContain('[Output truncated.')
    expect(parts[0].content[0].text.length).toBeLessThan(16_200)
    expect(parts[1].isError).toBe(true)
    expect(String(result.content).length).toBeLessThanOrEqual(24_000)
  })

  it('ends research at its iteration limit instead of executing tools after the last response', async () => {
    const read = readonlyTool()
    const send = vi.fn().mockResolvedValue(response('', [{ id: 'again', name: 'read_file', input: { path: 'one.ts' } }]))
    const tool = createSubagentTool({ send } as unknown as AIGateway, policy, { createTools: () => [read], maxIterations: 1 })
    const result = await tool.execute({ task: 'Inspect files' }, ctx)
    expect(send).toHaveBeenCalledTimes(2)
    expect(read.execute).toHaveBeenCalledOnce()
    expect(result.isError).toBe(true)
  })

  it('cancels an in-flight child read without another request, even if the handler ignores abort', async () => {
    const controller = new AbortController()
    const read = readonlyTool()
    const started = new Promise<void>((resolve) => {
      read.execute = vi.fn(() => { resolve(); return new Promise<ToolResult>(() => {}) })
    })
    const send = vi.fn().mockResolvedValue(response('', [{ id: 'read', name: 'read_file', input: { path: 'large.ts' } }]))
    const events = vi.fn()
    const tool = createSubagentTool({ send } as unknown as AIGateway, policy, { createTools: () => [read], onToolActivity: events })
    const pending = tool.execute({ task: 'Read a file' }, { ...ctx, signal: controller.signal })
    await started
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.content).toContain('cancelled')
    expect(send).toHaveBeenCalledOnce()
    expect(events.mock.calls.map(([event]) => event.phase)).toEqual(['running', 'error'])
  })

  it('cancels model requests and bounds a stalled subtask with its own deadline', async () => {
    vi.useFakeTimers()
    try {
      const send = vi.fn(() => new Promise(() => {}))
      const tool = createSubagentTool({ send } as unknown as AIGateway, policy, { maxDurationMs: 10 })
      const pending = tool.execute({ task: 'Analyze supplied context' }, ctx)
      await vi.advanceTimersByTimeAsync(11)
      expect(await pending).toMatchObject({ isError: true, content: 'Subagent time budget reached.' })
      expect(send.mock.calls).toHaveLength(1)
    } finally { vi.useRealTimers() }
  })

  it('inherits parent fallback routing and enforces output caps after target parameter merging', async () => {
    const primary = new MockAIProvider({ id: 'p', scenario: 'auth_error' })
    const backup = new MockAIProvider({ id: 'backup', reply: 'backup report' })
    const spy = vi.spyOn(backup, 'sendMessage')
    const gw = new AIGateway((id) => id === 'p' ? primary : backup)
    const parent = { ...policy, primary: { ...policy.primary, params: { maxOutputTokens: 8000 } }, fallbackEnabled: true,
      fallbacks: [{ providerId: 'backup', model: 'mock-large', params: { maxOutputTokens: 9000 } }] }
    const tool = createSubagentTool(gw, parent, { maxOutputTokens: 256 })
    const result = await tool.execute({ task: 'Analyze' }, ctx)
    expect(result.content).toBe('backup report')
    expect(spy.mock.calls[0]?.[0].params?.maxOutputTokens).toBe(256)
  })

  it('creates fresh tool state per invocation and retains safety rules with custom profiles', async () => {
    const makeTools = vi.fn(() => [readonlyTool()])
    const send = vi.fn().mockResolvedValue(response('Findings'))
    const tool = createSubagentTool({ send } as unknown as AIGateway, policy, {
      createTools: makeTools, systemPrompt: 'Workspace: /project',
      profiles: [{ name: 'review', description: 'Review', systemPrompt: 'Inspect the parser.' }]
    })
    await tool.execute({ task: 'First independent task', agent: 'review' }, ctx)
    await tool.execute({ task: 'Second independent task' }, ctx)
    expect(makeTools).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0]?.[0].system).toContain('Workspace: /project')
    expect(send.mock.calls[0]?.[0].system).toContain('Inspect the parser.')
    expect(send.mock.calls[0]?.[0].system).toContain('Read-only subtask rules')
    expect(JSON.stringify(send.mock.calls[1]?.[0].messages)).not.toContain('First independent task')
  })
})

describe('createSubagentTool assistant turn replay', () => {
  it('sends interleaved thinking back in order with its signatures', async () => {
    const calls: ToolCall[] = [
      { id: 'toolu_A', name: 'read_file', input: { path: 'a.ts' } },
      { id: 'toolu_B', name: 'read_file', input: { path: 'b.ts' } }
    ]
    const first: AIResponse = {
      ...response('', calls),
      content: [
        { type: 'reasoning', text: 'a first', signature: 'sig-A' },
        { type: 'tool_use', ...calls[0]! },
        { type: 'reasoning', text: 'then b', signature: 'sig-B' },
        { type: 'tool_use', ...calls[1]! }
      ]
    }
    const send = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(response('Compared.'))
    const tool = createSubagentTool({ send } as unknown as AIGateway, policy, { createTools: () => [readonlyTool()] })
    await tool.execute({ task: 'Compare a and b' }, ctx)
    const assistant = send.mock.calls[1]?.[0].messages.find((m: { role: string }) => m.role === 'assistant')
    expect(assistant.content).toEqual(first.content)
  })
})
