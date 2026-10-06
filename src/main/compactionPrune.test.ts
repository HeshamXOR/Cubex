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

  it('uses the documented defaults of 40k protected and 20k minimum reclaim', () => {
    const out = pruneToolResults(tenReads())
    expect(out.prunedToolUseIds).toHaveLength(6)
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

  it('keeps the first line of an error result and its error flag', () => {
    const input = [user('go'), ...exchange('e', 'run_command', body(25_000, 'Error: ENOENT: no such file or directory, open "src/a.ts"'), true),
      ...exchange('keep', 'read_file', body(5_000))]
    const out = pruneToolResults(input, { protectTokens: 1_000, minReclaimTokens: 1_000 })
    const part = out.messages[2]!.content[0]!
    expect(part).toMatchObject({ type: 'tool_result', toolUseId: 'e', isError: true })
    expect(resultText(out.messages[2]!)).toContain('Error: ENOENT: no such file or directory, open "src/a.ts"')
    expect(resultText(out.messages[2]!)).toMatch(/^\[Pruned tool error:/)
  })

  it('writes the first line, the size and the saved output id into the stub', () => {
    const id = '5b1f3c52-8a7e-4f0d-9c55-0d5e1d7a7a10'
    const text = `$ npm test\n${'y'.repeat(60_000)}\n\nSaved output: ${id} (60 KB). Use read_command_output with output_id=${id} to read or continue.`
    const input = [user('go'), ...exchange('c', 'run_command', text), ...exchange('keep', 'read_file', body(5_000))]
    const out = pruneToolResults(input, { protectTokens: 1_000, minReclaimTokens: 1_000 })
    const stub = resultText(out.messages[2]!)
    expect(stub).toContain('$ npm test')
    expect(stub).toMatch(/60,\d{3} characters/)
    expect(stub).toContain(`Output saved as ${id}; use read_command_output`)
    expect(estimateTextTokens(stub)).toBeLessThan(150)
  })

  it('takes an explicit output id from the caller when the text does not carry one', () => {
    const input = [user('go'), ...exchange('c', 'run_command', body(10_000)), ...exchange('keep', 'read_file', body(5_000))]
    const out = pruneToolResults(input, { protectTokens: 1_000, minReclaimTokens: 1_000, outputIds: new Map([['c', 'out-123']]) })
    expect(resultText(out.messages[2]!)).toContain('Output saved as out-123; use read_command_output')
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

  it('leaves small results alone because a stub would not be shorter', () => {
    const input = [user('go'), ...exchange('small', 'run_command', 'Done.'), ...exchange('big', 'read_file', body(30_000)), ...exchange('keep', 'read_file', body(5_000))]
    const out = pruneToolResults(input, { protectTokens: 1_000, minReclaimTokens: 1_000 })
    expect(out.prunedToolUseIds).toEqual(['big'])
    expect(out.messages[2]).toBe(input[2])
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

  it('does not modify its input', () => {
    const input = tenReads()
    const before = structuredClone(input)
    pruneToolResults(input)
    expect(input).toEqual(before)
  })

  it('is deterministic and idempotent', () => {
    const input = tenReads()
    const once = pruneToolResults(input)
    expect(pruneToolResults(input)).toEqual(once)
    const twice = pruneToolResults(once.messages)
    expect(twice.messages).toBe(once.messages)
    expect(twice.reclaimedTokens).toBe(0)
    expect(twice.prunedToolUseIds).toEqual([])
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

  it('counts an image in a result and drops it with the rest of the content', () => {
    const image: MessageContentPart = { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'AAAA' } }
    const input: AIMessage[] = [user('go'), calls(['shot', 'screenshot']),
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'shot', content: [{ type: 'text', text: 'Screenshot taken' }, ...Array.from({ length: 30 }, () => image as never)] }] },
      ...exchange('keep', 'read_file', body(5_000))]
    const out = pruneToolResults(input, { protectTokens: 1_000, minReclaimTokens: 1_000 })
    expect(out.prunedToolUseIds).toEqual(['shot'])
    expect(JSON.stringify(out.messages[2])).not.toContain('AAAA')
    expect(resultText(out.messages[2]!)).toContain('Screenshot taken')
  })

  it('returns an empty list unchanged', () => {
    const empty: AIMessage[] = []
    expect(pruneToolResults(empty).messages).toBe(empty)
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

  it('prunes the older large results and keeps the newer ones, and really prunes in many seeds', () => {
    let pruningSeeds = 0
    for (let seed = 1; seed <= 300; seed++) {
      const input = randomConversation(seed + 1_000)
      const out = pruneToolResults(input, { protectTokens: 10_000, minReclaimTokens: 1 })
      if (out.prunedToolUseIds.length) pruningSeeds++
      const pruned = new Set(out.prunedToolUseIds)
      const names = new Map(input.flatMap((message) => message.content.flatMap((part) => (part.type === 'tool_use' ? [[part.id, part.name] as const] : []))))
      // Large, prunable results in conversation order.
      const large = input.flatMap((message, mi) => message.content.flatMap((part, pi) => (
        part.type === 'tool_result' && !PRUNE_PROTECTED_TOOLS.has(names.get(part.toolUseId) ?? '') && tokens(message, pi) > 200 ? [part.toolUseId] : [])))
      // Everything from the first kept large result on is kept: the stubs form an oldest-first prefix.
      const firstKept = large.findIndex((id) => !pruned.has(id))
      if (firstKept >= 0) for (const id of large.slice(firstKept)) expect(pruned.has(id)).toBe(false)
    }
    expect(pruningSeeds).toBeGreaterThan(60)
  })
})
