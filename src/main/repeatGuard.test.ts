import { describe, expect, it } from 'vitest'
import { RepeatGuard, canonicalInput } from './repeatGuard'

describe('RepeatGuard', () => {
  it('stays quiet for the first two identical calls and notes the third', () => {
    const guard = new RepeatGuard()
    expect(guard.record('read_file', { path: 'a.ts' })).toEqual({})
    expect(guard.record('read_file', { path: 'a.ts' })).toEqual({})
    const third = guard.record('read_file', { path: 'a.ts' })
    expect(third.stop).toBeUndefined()
    expect(third.note).toMatch(/same read_file call/)
    expect(third.note).toMatch(/Change your approach/)
  })

  it('treats key order as irrelevant and nested differences as different calls', () => {
    const guard = new RepeatGuard()
    guard.record('run_command', { command: 'ls', opts: { a: 1, b: 2 } })
    guard.record('run_command', { opts: { b: 2, a: 1 }, command: 'ls' })
    expect(guard.record('run_command', { command: 'ls', opts: { a: 1, b: 2 } }).note).toBeDefined()
    expect(canonicalInput({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonicalInput({ a: [2, { c: 2, d: 1 }], b: 1 }))
    const other = new RepeatGuard()
    other.record('run_command', { opts: { a: 1 } })
    other.record('run_command', { opts: { a: 1 } })
    expect(other.record('run_command', { opts: { a: 2 } })).toEqual({})
  })

  it('only counts calls in a row for the note', () => {
    const guard = new RepeatGuard()
    guard.record('read_file', { path: 'a' })
    guard.record('read_file', { path: 'a' })
    guard.record('list_files', {})
    expect(guard.record('read_file', { path: 'a' }).note).toBeUndefined()
  })

  it('stops the turn when 5 of the last 10 calls are the same, even if interleaved', () => {
    const guard = new RepeatGuard()
    const verdicts = []
    for (let i = 0; i < 5; i++) {
      verdicts.push(guard.record('read_file', { path: 'a' }))
      if (i < 4) guard.record('search_files', { query: `q${i}` })
    }
    expect(verdicts[3]!.stop).toBeUndefined()
    expect(verdicts[4]!.stop).toBe('Stopped: the agent made the same read_file call 5 times.')
  })

  it('stops five identical calls in a row, after noting the third', () => {
    const guard = new RepeatGuard()
    const results = Array.from({ length: 5 }, () => guard.record('read_file', { path: 'a' }))
    expect(results[2]!.note).toBeDefined()
    expect(results[4]!.stop).toBe('Stopped: the agent made the same read_file call 5 times.')
  })

  it('forgets calls that fell out of the window of 10', () => {
    const guard = new RepeatGuard()
    for (let i = 0; i < 4; i++) guard.record('read_file', { path: 'a' })
    for (let i = 0; i < 10; i++) guard.record('search_files', { query: `q${i}` })
    expect(guard.record('read_file', { path: 'a' })).toEqual({})
  })

  it('starts over after reset', () => {
    const guard = new RepeatGuard()
    for (let i = 0; i < 4; i++) guard.record('read_file', { path: 'a' })
    guard.reset()
    expect(guard.record('read_file', { path: 'a' })).toEqual({})
  })

  it('never stops a fix-and-test loop: the same command after an edit is new work', () => {
    const guard = new RepeatGuard()
    for (let edits = 0; edits < 8; edits++) {
      expect(guard.record('edit_file', { path: 'src/a.ts', old_string: `v${edits}`, new_string: `v${edits + 1}` }, edits)).toEqual({})
      expect(guard.record('run_command', { command: 'npm test' }, edits + 1)).toEqual({})
    }
  })

  it('still stops the same command run again and again with no edit between', () => {
    const guard = new RepeatGuard()
    const verdicts = Array.from({ length: 5 }, () => guard.record('run_command', { command: 'npm test' }, 2))
    expect(verdicts[2]?.note).toBeDefined()
    expect(verdicts[4]?.stop).toBe('Stopped: the agent made the same run_command call 5 times.')
  })
})
