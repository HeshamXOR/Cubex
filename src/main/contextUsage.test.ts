import { describe, expect, it } from 'vitest'
import type { AIRequest, MessageContentPart } from '@core/types'
import { CONTEXT_SAFETY_MARGIN_TOKENS, effectiveContextWindow, estimateContextUsage, estimateTextTokens } from './contextUsage'
import { normalizeUserAttachments } from './attachments'
import { formatSummaryMessage } from './contextHistory'

const empty = (): AIRequest => ({ model: 'example-model', messages: [] })
const section = (request: AIRequest, id: string) => estimateContextUsage(request).sections.find((row) => row.id === id)!

describe('request context accounting', () => {
  it('keeps empty context and an unknown provider output limit honest', () => {
    const result = estimateContextUsage(empty(), { now: 123 })
    expect(result.estimatedTokens).toBe(0)
    expect(result.sections).toHaveLength(6)
    expect(result.sections.every((row) => row.estimatedTokens === 0 && row.count === 0)).toBe(true)
    expect(result).toMatchObject({ outputReserve: 0, outputReserveKnown: false, updatedAt: 123 })
    expect(result.contextWindow).toBeUndefined()
    expect(result.measuredInputTokens).toBeUndefined()
  })

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

  it('excludes binary data, URLs and provider file ids from text token estimates', () => {
    const parts: MessageContentPart[] = [
      { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'A'.repeat(2_000_000) } },
      { type: 'audio', mediaType: 'audio/wav', source: { kind: 'url', url: 'https://example.com/audio.wav' } },
      { type: 'file', source: { kind: 'file_id', id: 'provider-file' }, filename: 'report.pdf' },
      { type: 'video', mediaType: 'video/mp4', source: { kind: 'url', url: 'https://example.com/video.mp4' } },
      { type: 'tool_result', toolUseId: 'screenshot', content: [{ type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'AAAA' } }] }
    ]
    const result = estimateContextUsage({ ...empty(), messages: [{ role: 'user', content: parts }] })
    const attachments = result.sections.find((row) => row.id === 'attachments')!
    expect(attachments).toMatchObject({ count: 5, estimatedTokens: 0, characters: 0 })
    expect(attachments.details?.find((row) => row.id === 'image')?.count).toBe(2)
    expect(result.attachmentEstimateIncomplete).toBe(true)
    expect(result.estimatedTokens).toBeLessThan(100)
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

  it('keeps unavailable historical files honest while still marking image estimates incomplete', () => {
    const content = normalizeUserAttachments([
      { type: 'file', filename: 'report.pdf', source: { kind: 'base64', mediaType: 'application/pdf', data: 'AAAA' } },
      { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'AAAA' } }
    ], { historical: true })
    const result = estimateContextUsage({ ...empty(), messages: [{ role: 'user', content }] })
    expect(result.sections.find((row) => row.id === 'attachments')).toMatchObject({ count: 1, estimatedTokens: 0 })
    expect(result.sections.find((row) => row.id === 'conversation')!.characters).toBeGreaterThan(0)
    expect(result.attachmentEstimateIncomplete).toBe(true)
  })

  it('reports output reservation and measured input separately from estimated input', () => {
    const request = { ...empty(), system: 'Context', params: { maxOutputTokens: 2048 } }
    const result = estimateContextUsage(request, { contextWindow: 32_000, measuredInputTokens: 400, provider: 'test' })
    expect(result).toMatchObject({ contextWindow: 32_000, outputReserve: 2048, outputReserveKnown: true, measuredInputTokens: 400, provider: 'test' })
    expect(result.estimatedTokens).toBeLessThan(100)
    expect(estimateContextUsage(request).measuredInputTokens).toBeUndefined()
  })

  it('does not expose invalid numeric limits and preserves a valid measured zero', () => {
    const result = estimateContextUsage({ ...empty(), params: { maxOutputTokens: Number.NaN } }, { contextWindow: Infinity, measuredInputTokens: 0 })
    expect(result.contextWindow).toBeUndefined()
    expect(result.outputReserveKnown).toBe(false)
    expect(result.measuredInputTokens).toBe(0)
    expect(estimateContextUsage(empty(), { measuredInputTokens: -1 }).measuredInputTokens).toBeUndefined()
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

  it('rejects stale source labels instead of presenting a false breakdown', () => {
    const result = estimateContextUsage({ ...empty(), system: 'New system instructions' }, { systemSources: [{ id: 'old', label: 'Old', text: 'Outdated instructions' }] })
    expect(result.sections.find((row) => row.id === 'system')?.details).toBeUndefined()
    expect(result.estimatedTokens).toBeGreaterThan(0)
  })

  it('accounts for structured system content and legacy tool-role text', () => {
    const result = estimateContextUsage({ ...empty(), system: [{ type: 'text', text: 'System text' }], messages: [{ role: 'tool', content: [{ type: 'text', text: 'Legacy result' }] }] })
    expect(result.sections.find((row) => row.id === 'system')).toMatchObject({ count: 1, characters: 11 })
    expect(result.sections.find((row) => row.id === 'toolResults')).toMatchObject({ count: 1, characters: 13 })
    expect(result.sections.find((row) => row.id === 'conversation')?.estimatedTokens).toBe(0)
  })

  it('uses a deterministic Unicode-aware heuristic without claiming a model tokenizer', () => {
    expect(estimateTextTokens('')).toBe(0)
    expect(estimateTextTokens('编码上下文')).toBeGreaterThan(estimateTextTokens('abcdef'))
    expect(estimateContextUsage({ ...empty(), system: 'مرحبا' }, { now: 500 })).toEqual(estimateContextUsage({ ...empty(), system: 'مرحبا' }, { now: 500 }))
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

  it('does not change the request total or the section list', () => {
    const result = estimateContextUsage(withSummary())
    expect(result.sections.map((row) => row.id)).toEqual(['system', 'conversation', 'toolResults', 'tools', 'mcp', 'attachments'])
    expect(result.estimatedTokens).toBe(result.sections.reduce((sum, row) => sum + row.estimatedTokens, 0))
  })

  it('leaves conversations without a summary exactly as before', () => {
    expect(conversation({ ...empty(), messages: withSummary().messages.slice(1) }).details).toBeUndefined()
  })

  it('counts only the first matching message as the summary', () => {
    const request = withSummary()
    request.messages.push({ role: 'user', content: [{ type: 'text', text: summaryText }] })
    expect(conversation(request).details?.find((row) => row.id === 'summary')?.count).toBe(1)
    expect(conversation(request).details?.find((row) => row.id === 'messages')?.count).toBe(3)
  })

  it('does not mistake an ordinary message that mentions the tag for the summary', () => {
    const request = { ...empty(), messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'What is a <conversation_summary> block?' }] }] }
    expect(conversation(request).details).toBeUndefined()
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

/**
 * Bands are characters per token. The lower bound of each band is the floor a
 * real tokenizer would not go below for that content, so an estimate above it
 * (fewer characters per token) is the conservative side we want; the upper
 * bound catches a regression back into optimistic counting.
 */
describe('estimateTextTokens calibration', () => {
  const prose = 'The quick brown fox jumps over the lazy dog, and the team shipped the parser on a rainy Tuesday afternoon. '.repeat(12)
  const typescript = `
export interface ContextUsageOptions {
  provider?: string
  contextWindow?: number
}

export function estimateContextUsage(request: AIRequest, options: ContextUsageOptions = {}): ContextUsageSnapshot {
  const sections = [{ id: 'system', estimatedTokens: 0, count: 0 }]
  for (const message of request.messages) {
    if (message.role === 'tool' || message.role === 'system') continue
    sections[0]!.estimatedTokens += estimateTextTokens(JSON.stringify(message.content))
  }
  return { sections, estimatedTokens: sections.reduce((sum, row) => sum + row.estimatedTokens, 0) }
}
`.repeat(3)
  const json = JSON.stringify({
    items: Array.from({ length: 40 }, (_, index) => ({
      id: `item-${index}`, name: `Widget ${index}`, enabled: index % 2 === 0, score: index * 1.5, tags: ['alpha', 'beta']
    }))
  })
  const cjk = '编码上下文窗口压缩与令牌计数的估算方法需要保守一些，否则会在真正溢出之前都不会触发压缩。'.repeat(8)
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk'.repeat(10)

  it.each([
    // [name, sample, min chars/token, max chars/token]
    ['english prose', prose, 3.2, 4.4],
    ['typescript source', typescript, 2.3, 3.5],
    ['json blob', json, 1.9, 3.0],
    ['cjk text', cjk, 0.7, 1.1],
    ['base64 blob', base64, 2.3, 3.2]
  ])('keeps %s inside its band and never under-counts it', (_name, sample, min, max) => {
    const tokens = estimateTextTokens(sample)
    const charsPerToken = sample.length / tokens
    expect(charsPerToken).toBeGreaterThanOrEqual(min)
    expect(charsPerToken).toBeLessThanOrEqual(max)
  })

  it('counts code, json and cjk above the old four-bytes-per-token rule', () => {
    for (const sample of [typescript, json, cjk, base64]) {
      expect(estimateTextTokens(sample)).toBeGreaterThan(Math.ceil(Buffer.byteLength(sample, 'utf8') / 4))
    }
  })

  it('stays stable and roughly linear once sampling kicks in', () => {
    const long = typescript.repeat(400)
    expect(long.length).toBeGreaterThan(65_536)
    expect(estimateTextTokens(long)).toBe(estimateTextTokens(long))
    const ratio = estimateTextTokens(long) / (estimateTextTokens(typescript) * 400)
    expect(ratio).toBeGreaterThan(0.9)
    expect(ratio).toBeLessThan(1.1)
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

  it('publishes the input budget left after the output reservation', () => {
    const withCap = { ...request, params: { maxOutputTokens: 4_000 } }
    expect(estimateContextUsage(withCap, { contextWindow: 10_000 }).inputBudget).toBe(10_000 - 4_000 - CONTEXT_SAFETY_MARGIN_TOKENS)
    expect(estimateContextUsage(request, { contextWindow: 10_000 }).inputBudget).toBe(10_000)
    expect(estimateContextUsage(request, {}).inputBudget).toBeUndefined()
  })
})
