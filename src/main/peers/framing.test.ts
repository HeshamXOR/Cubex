import { describe, expect, it } from 'vitest'
import { consultPrompt, consultProtocol } from './framing'
import { MAX_EXCHANGES, MAX_HISTORY_CHARS, PeerTranscripts } from './transcript'

describe('the protocol', () => {
  it('asks for an honest view that ends in a verdict, and for no changes', () => {
    const text = consultProtocol(false)
    expect(text).toContain('Verdict: agree')
    expect(text).toContain('Verdict: partly agree')
    expect(text).toContain('Verdict: disagree')
    expect(text).toMatch(/Do not edit files, run commands or change anything/)
    expect(text).toMatch(/cannot see the agent's conversation or the person's files/)
  })

  it('says the project can be read only when it can', () => {
    expect(consultProtocol(true)).toMatch(/may read its files/)
    expect(consultProtocol(false)).not.toMatch(/may read its files/)
  })
})

describe('the prompt a program gets', () => {
  it('is the protocol and the message when it is the first', () => {
    const prompt = consultPrompt([], 'Is this safe?', false)
    expect(prompt.startsWith(consultProtocol(false))).toBe(true)
    expect(prompt.endsWith("The agent's message:\n\nIs this safe?")).toBe(true)
    expect(prompt).not.toContain('Earlier in this conversation')
  })

  it('carries what was said before, oldest first, with who said it', () => {
    const prompt = consultPrompt([{ message: 'one', reply: 'two' }, { message: 'three', reply: 'four' }], 'five', false)
    const at = (text: string): number => prompt.indexOf(text)
    expect(prompt).toContain('Earlier in this conversation, oldest first:')
    expect(at('Agent: one')).toBeLessThan(at('You: two'))
    expect(at('You: two')).toBeLessThan(at('Agent: three'))
    expect(at('You: four')).toBeLessThan(at('five'))
  })
})

describe('the talk with an agent', () => {
  it('is kept per task and per agent', () => {
    const talks = new PeerTranscripts()
    talks.record('t1', 'a', { message: 'm1', reply: 'r1' })
    talks.record('t1', 'b', { message: 'm2', reply: 'r2' })
    talks.record('t2', 'a', { message: 'm3', reply: 'r3' })
    expect(talks.history('t1', 'a')).toEqual([{ message: 'm1', reply: 'r1' }])
    expect(talks.history('t1', 'b')).toEqual([{ message: 'm2', reply: 'r2' }])
    expect(talks.history('t2', 'a')).toEqual([{ message: 'm3', reply: 'r3' }])
    expect(talks.history('t3', 'a')).toEqual([])
  })

  it('keeps the newest rounds only', () => {
    const talks = new PeerTranscripts()
    for (let i = 0; i < MAX_EXCHANGES + 3; i++) talks.record('t', 'a', { message: `m${i}`, reply: `r${i}` })
    const kept = talks.history('t', 'a')
    expect(kept).toHaveLength(MAX_EXCHANGES)
    expect(kept[0]?.message).toBe('m3')
    expect(kept[kept.length - 1]?.message).toBe(`m${MAX_EXCHANGES + 2}`)
  })

  it('keeps no more text than the limit, but always the newest round', () => {
    const talks = new PeerTranscripts()
    for (let i = 0; i < 5; i++) talks.record('t', 'a', { message: 'q'.repeat(9_000), reply: 'a'.repeat(9_000) })
    const kept = talks.history('t', 'a')
    expect(kept.reduce((sum, entry) => sum + entry.message.length + entry.reply.length, 0)).toBeLessThanOrEqual(MAX_HISTORY_CHARS)
    expect(kept.length).toBeGreaterThanOrEqual(1)
    talks.record('t', 'x', { message: 'q'.repeat(60_000), reply: 'a'.repeat(60_000) })
    const huge = talks.history('t', 'x')
    expect(huge).toHaveLength(1)
    expect(huge[0]!.message.length).toBeLessThan(11_000)
  })

  it('forgets one agent, or a whole task', () => {
    const talks = new PeerTranscripts()
    talks.record('t1', 'a', { message: 'm', reply: 'r' })
    talks.record('t1', 'b', { message: 'm', reply: 'r' })
    talks.record('t2', 'a', { message: 'm', reply: 'r' })
    talks.forget('t1', 'a')
    expect(talks.history('t1', 'a')).toEqual([])
    expect(talks.history('t1', 'b')).toHaveLength(1)
    talks.forgetConversation('t1')
    expect(talks.history('t1', 'b')).toEqual([])
    expect(talks.history('t2', 'a')).toHaveLength(1)
  })

  it('does not let one task name reach another that starts with it', () => {
    const talks = new PeerTranscripts()
    talks.record('task', 'a', { message: 'm', reply: 'r' })
    talks.record('task-2', 'a', { message: 'm', reply: 'r' })
    talks.forgetConversation('task')
    expect(talks.history('task-2', 'a')).toHaveLength(1)
  })
})
