import { describe, expect, it } from 'vitest'
import type { AIMessage, MessageContentPart } from '@core/types'
import { estimateTextTokens } from './contextUsage'
import { PRUNE_PROTECTED_TOOLS, pruneToolResults } from './compaction'

/** n tokens of plain text by the harness estimate (four bytes each), with a recognizable first line. */
/**
 * Content the estimator values at about `tokens`. Sized against
 * `estimateTextTokens` itself rather than a fixed bytes-per-token rate, so the
 * token figures asserted below stay meaningful when it is recalibrated.
 */
const body = (tokens: number, first = 'first line of the output'): string => {
  const fill = (count: number): string => `${first}\n${'x'.repeat(Math.max(0, Math.round(count)))}`
  let count = tokens * 4
  for (let step = 0; step < 6; step++) {
    const actual = estimateTextTokens(fill(count))
    if (actual === tokens || actual <= 0) break
    count = Math.max(0, count * tokens / actual)
  }
  return fill(count)
}

const user = (text: string): AIMessage => ({ role: 'user', content: [{ type: 'text', text }] })
const assistantText = (text: string): AIMessage => ({ role: 'assistant', content: [{ type: 'text', text }] })
const calls = (...items: Array<[string, string]>): AIMessage => ({
  role: 'assistant', content: items.map(([id, name]) => ({ type: 'tool_use', id, name, input: { id } }))
})
const results = (...items: Array<[string, string, boolean?]>): AIMessage => ({
  role: 'tool',
  content: items.map(([id, text, isError]): MessageContentPart => ({
    type: 'tool_result', toolUseId: id, content: [{ type: 'text', text }], ...(isError ? { isError: true } : {})
  }))
})
/** A tool call and its result as two messages. */
const exchange = (id: string, name: string, text: string, isError = false): AIMessage[] => [calls([id, name]), results([id, text, isError])]

const resultText = (message: AIMessage, index = 0): string => {
  const part = message.content[index]
  if (part?.type !== 'tool_result') throw new Error('not a tool result')
  return part.content.map((item) => (item.type === 'text' ? item.text : '')).join('')
}
const idsOf = (messages: readonly AIMessage[], type: 'tool_use' | 'tool_result'): string[] =>
  messages.flatMap((message) => message.content.flatMap((part) => (part.type === 'tool_use' && type === 'tool_use' ? [part.id] : part.type === 'tool_result' && type === 'tool_result' ? [part.toolUseId] : [])))

/** Ten reads of 10k tokens each, after a user message. */
function tenReads(): AIMessage[] {
  return [user('Read everything'), ...Array.from({ length: 10 }, (_, i) => exchange(`t${i + 1}`, 'read_file', body(10_000, `file ${i + 1}`))).flat()]
}

describe('pruneToolResults', () => {
  it('keeps the protected tail and stubs everything older', () => {
    const input = tenReads()
    const out = pruneToolResults(input, { protectTokens: 40_000, minReclaimTokens: 20_000 })
    expect(out.prunedToolUseIds).toEqual(['t1', 't2', 't3', 't4', 't5', 't6'])
    // The newest four results (40k tokens) are untouched, the older six are stubs.
    for (let i = 1; i <= 6; i++) expect(resultText(out.messages[i * 2]!)).toMatch(/^\[Pruned tool output:/)
    for (let i = 7; i <= 10; i++) expect(out.messages[i * 2]).toBe(input[i * 2])
    expect(out.reclaimedTokens).toBeGreaterThan(59_000)
    expect(out.reclaimedTokens).toBeLessThanOrEqual(60_000)
  })

  it('does nothing when less than the minimum would be reclaimed', () => {
    const input = [user('go'), ...exchange('a', 'read_file', body(10_000)), ...exchange('b', 'read_file', body(10_000)), ...exchange('c', 'read_file', body(10_000))]
    // Protecting 20k leaves one 10k result prunable: below the 20k gate.
    const out = pruneToolResults(input, { protectTokens: 20_000, minReclaimTokens: 20_000 })
    expect(out.messages).toBe(input)
    expect(out.reclaimedTokens).toBe(0)
    expect(out.prunedToolUseIds).toEqual([])
  })

  it('never prunes the results of the final tool message, however large', () => {
    const input = [user('go'), ...exchange('old', 'read_file', body(30_000)),
      calls(['n1', 'read_file'], ['n2', 'read_file'], ['n3', 'read_file']),
      results(['n1', body(30_000)], ['n2', body(30_000)], ['n3', body(30_000)])]
    const out = pruneToolResults(input, { protectTokens: 1_000, minReclaimTokens: 1_000 })
    expect(out.prunedToolUseIds).toEqual(['old'])
    expect(out.messages.at(-1)).toBe(input.at(-1))
  })

  it('never touches skill, todo_write, exit_plan_mode or ask_user_question results', () => {
    expect([...PRUNE_PROTECTED_TOOLS].sort()).toEqual(['ask_user_question', 'exit_plan_mode', 'skill', 'todo_write'])
    const input = [user('go'),
      ...exchange('s', 'skill', body(15_000)), ...exchange('t', 'todo_write', body(15_000)),
      ...exchange('p', 'exit_plan_mode', body(15_000)), ...exchange('q', 'ask_user_question', body(15_000)),
      ...exchange('r', 'read_file', body(30_000)), ...exchange('keep', 'read_file', body(5_000))]
    const out = pruneToolResults(input, { protectTokens: 1_000, minReclaimTokens: 1_000 })
    expect(out.prunedToolUseIds).toEqual(['r'])
    for (const index of [2, 4, 6, 8]) expect(out.messages[index]).toBe(input[index])
  })

  it('keeps every tool call next to its result and never changes the message structure', () => {
    const input = tenReads()
    const out = pruneToolResults(input)
    expect(out.messages).toHaveLength(input.length)
    expect(out.messages.map((message) => message.role)).toEqual(input.map((message) => message.role))
    expect(idsOf(out.messages, 'tool_use')).toEqual(idsOf(input, 'tool_use'))
    expect(idsOf(out.messages, 'tool_result')).toEqual(idsOf(input, 'tool_result'))
    // The user message and the calls are the very same objects.
    expect(out.messages[0]).toBe(input[0])
    expect(out.messages[1]).toBe(input[1])
  })

  it('handles tool results carried in user-role messages and ignores orphan results', () => {
    const input: AIMessage[] = [user('go'), calls(['a', 'read_file']),
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'a', content: [{ type: 'text', text: body(30_000) }] }] },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'orphan', content: [{ type: 'text', text: body(30_000) }] }] },
      ...exchange('keep', 'read_file', body(5_000))]
    const out = pruneToolResults(input, { protectTokens: 1_000, minReclaimTokens: 1_000 })
    expect(out.prunedToolUseIds).toEqual(['a', 'orphan'])
    expect(out.messages[2]!.role).toBe('user')
  })
})

// ---------------------------------------------------------------------------
// Property-style checks over seeded random conversations
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TOOL_NAMES = ['read_file', 'run_command', 'search_files', 'web_fetch', 'todo_write', 'skill', 'exit_plan_mode', 'ask_user_question']
const SIZES = [0, 5, 40, 300, 2_000, 6_000, 12_000, 30_000]

function randomConversation(seed: number): AIMessage[] {
  const random = mulberry32(seed)
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
  const messages: AIMessage[] = [user('start')]
  let counter = 0
  const steps = 3 + Math.floor(random() * 14)
  for (let step = 0; step < steps; step++) {
    const roll = random()
    if (roll < 0.15) messages.push(assistantText(`note ${step}`))
    else if (roll < 0.25) messages.push(user(`follow up ${step}`))
    else {
      const count = 1 + Math.floor(random() * 3)
      const ids = Array.from({ length: count }, () => `id${++counter}`)
      const names = ids.map(() => pick(TOOL_NAMES))
      messages.push(calls(...ids.map((id, i): [string, string] => [id, names[i]!])))
      messages.push(results(...ids.map((id): [string, string, boolean] => [id, body(pick(SIZES), `line of ${id}`), random() < 0.12])))
    }
  }
  return messages
}

describe('pruneToolResults over random conversations', () => {
  const OPTIONS = [{ protectTokens: 40_000, minReclaimTokens: 20_000 }, { protectTokens: 10_000, minReclaimTokens: 1 }, { protectTokens: 0, minReclaimTokens: 5_000 }]
  const tokens = (message: AIMessage, index: number): number => estimateTextTokens(resultText(message, index))

  it('holds its invariants for 300 seeds and three option sets', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const input = randomConversation(seed)
      const snapshot = structuredClone(input)
      for (const options of OPTIONS) {
        const out = pruneToolResults(input, options)
        const again = pruneToolResults(input, options)
        // Deterministic, pure.
        expect(again).toEqual(out)
        expect(input).toEqual(snapshot)
        // Structure: same shape, same ids in the same order.
        expect(out.messages).toHaveLength(input.length)
        expect(idsOf(out.messages, 'tool_use')).toEqual(idsOf(input, 'tool_use'))
        expect(idsOf(out.messages, 'tool_result')).toEqual(idsOf(input, 'tool_result'))
        // Idempotent.
        const twice = pruneToolResults(out.messages, options)
        expect(twice.messages).toBe(out.messages)
        if (!out.prunedToolUseIds.length) {
          expect(out.messages).toBe(input)
          expect(out.reclaimedTokens).toBe(0)
          continue
        }
        expect(out.reclaimedTokens).toBeGreaterThanOrEqual(options.minReclaimTokens)
        const pruned = new Set(out.prunedToolUseIds)
        const names = new Map(input.flatMap((message) => message.content.flatMap((part) => (part.type === 'tool_use' ? [[part.id, part.name] as const] : []))))
        let measured = 0
        input.forEach((message, mi) => message.content.forEach((part, pi) => {
          if (part.type !== 'tool_result') return
          const after = out.messages[mi]!.content[pi]!
          if (PRUNE_PROTECTED_TOOLS.has(names.get(part.toolUseId) ?? '')) expect(after).toBe(part)
          if (mi === input.length - 1) expect(after).toBe(part)
          if (pruned.has(part.toolUseId)) {
            expect(after).not.toBe(part)
            expect((after as { isError?: boolean }).isError).toBe(part.isError)
            measured += tokens(message, pi) - tokens(out.messages[mi]!, pi)
          } else expect(after).toBe(part)
        }))
        expect(measured).toBe(out.reclaimedTokens)
      }
    }
  })
})
