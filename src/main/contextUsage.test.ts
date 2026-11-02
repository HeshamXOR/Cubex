import { describe, expect, it } from 'vitest'
import type { AIRequest } from '@core/types'
import { effectiveContextWindow, estimateContextUsage, estimateTextTokens } from './contextUsage'
import { normalizeUserAttachments } from './attachments'
import { formatSummaryMessage } from './contextHistory'

const empty = (): AIRequest => ({ model: 'example-model', messages: [] })
const section = (request: AIRequest, id: string) => estimateContextUsage(request).sections.find((row) => row.id === id)!

describe('request context accounting', () => {

  it('partitions system, dialog and tool results without counting a result as dialog', () => {
    const request: AIRequest = {
      ...empty(), system: 'Harness instructions.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Please inspect.' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'read', name: 'read_file', input: { path: 'source.ts' } }] },
        { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'read', content: [{ type: 'text', text: 'x'.repeat(4000) }] }] }
      ]
    }
    const result = estimateContextUsage(request)
    expect(result.sections.find((row) => row.id === 'system')?.count).toBe(1)
    expect(result.sections.find((row) => row.id === 'conversation')?.count).toBe(2)
    expect(result.sections.find((row) => row.id === 'conversation')?.estimatedTokens).toBeLessThan(100)
    expect(result.sections.find((row) => row.id === 'toolResults')?.estimatedTokens).toBeGreaterThanOrEqual(1000)
    expect(result.estimatedTokens).toBe(result.sections.reduce((sum, row) => sum + row.estimatedTokens, 0))
  })

  it('charges exact serialized schemas to built-ins or their MCP server only', () => {
    const request: AIRequest = { ...empty(), tools: [
      { name: 'read_file', description: 'Read a source file', inputSchema: { type: 'object' } },
      { name: 'mcp__github__issues', description: 'Find issues', inputSchema: { type: 'object' } },
      { name: 'mcp__github__pulls', description: 'Find pull requests', inputSchema: { type: 'object' } },
      { name: 'mcp__docs__search', description: 'Search documentation', inputSchema: { type: 'object' } }
    ] }
    expect(section(request, 'tools').count).toBe(1)
    const mcp = section(request, 'mcp')
    expect(mcp.count).toBe(3)
    expect(mcp.details?.map((row) => [row.id, row.count])).toEqual([['github', 2], ['docs', 1]])
    expect(mcp.details?.reduce((sum, row) => sum + row.estimatedTokens, 0)).toBe(mcp.estimatedTokens)
    expect(section(request, 'conversation').estimatedTokens).toBe(0)
  })

  it('counts decoded upload text under Attachments exactly once, including its filename wrapper', () => {
    const content = normalizeUserAttachments([
      { type: 'text', text: 'Review this.' },
      { type: 'file', filename: 'source.ts', source: { kind: 'base64', mediaType: 'text/plain', data: Buffer.from('source '.repeat(100)).toString('base64') } }
    ])
    const request = { ...empty(), messages: [{ role: 'user' as const, content }] }
    const result = estimateContextUsage(request)
    const attachment = content[1]!
    expect(attachment.type).toBe('text')
    if (attachment.type !== 'text') throw new Error('Expected decoded text')
    const attachments = result.sections.find((row) => row.id === 'attachments')!
    expect(attachments).toMatchObject({ count: 1, characters: attachment.text.length, estimatedTokens: estimateTextTokens(attachment.text) })
    expect(attachments.details).toEqual([{ id: 'text_file', label: 'Text files', count: 1, characters: attachment.text.length, estimatedTokens: attachments.estimatedTokens }])
    expect(result.sections.find((row) => row.id === 'conversation')!.characters).toBe('Review this.'.length)
    expect(result.attachmentEstimateIncomplete).toBeUndefined()
    expect(result.estimatedTokens).toBe(result.sections.reduce((sum, row) => sum + row.estimatedTokens, 0))
  })

  it('groups exact source chunks, accounts for delimiters, and makes subrows add up', () => {
    const sources = [
      { id: 'harness', label: 'Harness', text: 'Core instructions.\n\n' },
      { id: 'project', label: 'Project', text: 'Read AGENTS.md.\n\n' },
      { id: 'user', label: 'User configuration', text: 'Keep changes focused.\n\n' },
      { id: 'harness', label: 'Harness', text: 'Active mode: plan.' }
    ]
    const system = sources.map((source) => source.text).join('')
    const result = estimateContextUsage({ ...empty(), system, messages: [{ role: 'developer', content: [{ type: 'text', text: 'Additional instruction.' }] }] }, { systemSources: sources })
    const row = result.sections.find((item) => item.id === 'system')!
    expect(row.details?.map((item) => item.id)).toEqual(['harness', 'project', 'user', 'history'])
    expect(row.details?.reduce((sum, item) => sum + item.estimatedTokens, 0)).toBe(row.estimatedTokens)
    expect(row.details?.reduce((sum, item) => sum + (item.characters ?? 0), 0)).toBe(row.characters)
  })
})

describe('compaction summary accounting', () => {
  const summaryText = formatSummaryMessage('Goal: ship the parser.\n- Edited src/parser/lexer.ts')
  const withSummary = (): AIRequest => ({
    ...empty(),
    messages: [
      { role: 'user', content: [{ type: 'text', text: summaryText }] },
      { role: 'user', content: [{ type: 'text', text: 'Next question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'An answer' }] }
    ]
  })
  const conversation = (request: AIRequest) => estimateContextUsage(request).sections.find((row) => row.id === 'conversation')!

  it('reports the summary as its own row under the conversation, adding up to the section', () => {
    const section = conversation(withSummary())
    expect(section.details?.map((row) => row.id)).toEqual(['summary', 'messages'])
    const [summary, messages] = section.details!
    expect(summary).toMatchObject({ label: 'Conversation summary', count: 1 })
    expect(messages).toMatchObject({ count: 2 })
    expect(summary!.estimatedTokens + messages!.estimatedTokens).toBe(section.estimatedTokens)
    expect((summary!.characters ?? 0) + (messages!.characters ?? 0)).toBe(section.characters)
    expect(summary!.estimatedTokens).toBeGreaterThan(estimateTextTokens('Goal: ship the parser.'))
    expect(summary!.characters).toBe(summaryText.length)
  })
})

describe('thinking in the request', () => {
  const thinking = (part: { signature?: string; redacted?: string }): AIRequest => ({
    ...empty(),
    messages: [{ role: 'assistant', content: [{ type: 'reasoning', text: 'Considering the options. '.repeat(400), ...part }, { type: 'text', text: 'Done.' }] }]
  })

  it('does not count plain thinking text, which no adapter sends back', () => {
    const plain = estimateContextUsage(thinking({})).estimatedTokens
    const none = estimateContextUsage({ ...empty(), messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }] }).estimatedTokens
    expect(plain).toBe(none)
  })

  it('counts thinking the provider signed, which is replayed with the tool results', () => {
    const signed = estimateContextUsage(thinking({ signature: 'sig' })).estimatedTokens
    const plain = estimateContextUsage(thinking({})).estimatedTokens
    expect(signed).toBeGreaterThan(plain + 1_000)
  })
})

describe('effectiveContextWindow', () => {
  it('reports the model window, or nothing when it is unknown or unusable', () => {
    expect(effectiveContextWindow({ contextWindow: 128_000 }, false)).toBe(128_000)
    expect(effectiveContextWindow(undefined, false)).toBeUndefined()
    expect(effectiveContextWindow({}, true)).toBeUndefined()
    expect(effectiveContextWindow({ contextWindow: 0 }, false)).toBeUndefined()
    expect(effectiveContextWindow({ contextWindow: Number.NaN }, false)).toBeUndefined()
  })

  it('caps a gated long-context model at 200k until the user opts in', () => {
    const model = { contextWindow: 1_000_000, longContextBeta: true }
    expect(effectiveContextWindow(model, false)).toBe(200_000)
    expect(effectiveContextWindow(model, true)).toBe(1_000_000)
    expect(effectiveContextWindow({ contextWindow: 150_000, longContextBeta: true }, false)).toBe(150_000)
    expect(effectiveContextWindow({ contextWindow: 1_000_000 }, false)).toBe(1_000_000)
  })
})

describe('context basis on the snapshot', () => {
  const request = { model: 'm', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'x'.repeat(4_000) }] }] }

  it('reports the estimate when there is no provider report yet', () => {
    const result = estimateContextUsage(request, { contextWindow: 10_000 })
    expect(result.contextBasis).toBe('estimated')
    expect(result.contextTokens).toBe(result.estimatedTokens)
    expect(result.anchorTokens).toBeUndefined()
  })

  it('reports the anchored number and keeps estimatedTokens as the section sum', () => {
    const plain = estimateContextUsage(request, { contextWindow: 10_000 })
    const result = estimateContextUsage(request, {
      contextWindow: 10_000, anchor: { inputTokens: 5_000, estimatedAtReport: plain.estimatedTokens }
    })
    expect(result.contextBasis).toBe('anchored')
    expect(result.contextTokens).toBe(5_000)
    expect(result.anchorTokens).toBe(5_000)
    expect(result.appendedTokens).toBe(0)
    expect(result.estimatedTokens).toBe(result.sections.reduce((sum, row) => sum + row.estimatedTokens, 0))
  })
})
