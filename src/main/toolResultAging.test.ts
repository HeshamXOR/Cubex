import { describe, expect, it } from 'vitest'
import type { AIMessage } from '@core/types'
import { ToolResultAger, capForAge, shortened } from './toolResultAging'

const WINDOW = 100_000

function run(count: number, size = 20_000, name = 'read_file'): AIMessage[] {
  const messages: AIMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'go' }] }]
  for (let i = 0; i < count; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name, input: {} }] })
    messages.push({ role: 'tool', content: [{ type: 'tool_result', toolUseId: `t${i}`, content: [{ type: 'text', text: `${i}:`.padEnd(size, 'x') }] }] })
  }
  return messages
}

const sizes = (messages: AIMessage[]): number[] => messages.flatMap((message) =>
  message.role === 'tool' ? message.content.flatMap((part) => (part.type === 'tool_result' ? part.content.map((item) => (item.type === 'text' ? item.text.length : 0)) : [])) : [])

describe('shortening older tool results', () => {
  it('leaves everything alone while the context has room', () => {
    const messages = run(30)
    expect(new ToolResultAger().apply(messages, 0.3, WINDOW)).toBe(messages)
  })

  it('keeps the newest whole and cuts older ones harder the older they are', () => {
    const sent = sizes(new ToolResultAger().apply(run(40), 0.6, WINDOW))
    expect(sent.slice(-4).every((size) => size === 20_000)).toBe(true)
    expect(sent[0]!).toBeLessThan(sent[30]!)
    expect(sent[30]!).toBeLessThan(20_000)
  })

  it('never changes the messages it was given', () => {
    const messages = run(40)
    new ToolResultAger().apply(messages, 0.6, WINDOW)
    expect(sizes(messages).every((size) => size === 20_000)).toBe(true)
  })

  it('keeps earlier results byte-identical between passes, so a prompt cache keeps hitting', () => {
    const ager = new ToolResultAger()
    const first = ager.apply(run(40), 0.6, WINDOW)
    const next = ager.apply(run(43), 0.6, WINDOW)
    expect(sizes(next).slice(0, 40)).toEqual(sizes(first))
  })

  it('makes another pass once enough new results have come in', () => {
    const ager = new ToolResultAger()
    const first = ager.apply(run(40), 0.6, WINDOW)
    const later = ager.apply(run(60), 0.6, WINDOW)
    expect(sizes(later)[30]!).toBeLessThan(sizes(first)[30]!)
  })

  it('does not bother when a pass would free too little to pay for the broken cache', () => {
    const messages = run(10, 9_000)
    expect(new ToolResultAger().apply(messages, 0.6, 1_000_000)).toBe(messages)
  })

  it('never shortens what the agent needs to keep, such as a loaded skill', () => {
    const sent = sizes(new ToolResultAger().apply(run(40, 20_000, 'skill'), 0.6, WINDOW))
    expect(sent.every((size) => size === 20_000)).toBe(true)
  })
})

describe('the rule itself', () => {
  it('halves the cap each time the age doubles, down to a floor', () => {
    expect(capForAge(3)).toBe(Number.POSITIVE_INFINITY)
    expect(capForAge(4)).toBe(8_000)
    expect(capForAge(8)).toBe(4_000)
    expect(capForAge(16)).toBe(2_000)
    expect(capForAge(10_000)).toBe(500)
  })

  it('keeps more of the end of a command, where a failure is reported', () => {
    const log = `${'start '.repeat(1000)}${'x'.repeat(5000)}FAILED: the error`
    const cut = shortened(log, 1_000, 'run_command')
    expect(cut).toContain('FAILED: the error')
    expect(cut).toContain('characters of this older tool result were cut')
    expect(shortened('short', 1_000, 'read_file')).toBe('short')
  })
})
