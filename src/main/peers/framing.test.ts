import { describe, expect, it } from 'vitest'
import { consultProtocol } from './framing'
import { MAX_EXCHANGES, PeerTranscripts } from './transcript'

describe('the protocol', () => {
  it('asks for an honest view that ends in a verdict, and for no changes', () => {
    const text = consultProtocol(false)
    expect(text).toContain('Verdict: agree')
    expect(text).toContain('Verdict: partly agree')
    expect(text).toContain('Verdict: disagree')
    expect(text).toMatch(/Do not edit files, run commands or change anything/)
    expect(text).toMatch(/cannot see the agent's conversation or the person's files/)
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

  it('does not let one task name reach another that starts with it', () => {
    const talks = new PeerTranscripts()
    talks.record('task', 'a', { message: 'm', reply: 'r' })
    talks.record('task-2', 'a', { message: 'm', reply: 'r' })
    talks.forgetConversation('task')
    expect(talks.history('task-2', 'a')).toHaveLength(1)
  })
})
