import { describe, expect, it } from 'vitest'
import { RepeatGuard } from './repeatGuard'

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

  it('never stops a fix-and-test loop: the same command after an edit is new work', () => {
    const guard = new RepeatGuard()
    for (let edits = 0; edits < 8; edits++) {
      expect(guard.record('edit_file', { path: 'src/a.ts', old_string: `v${edits}`, new_string: `v${edits + 1}` }, edits)).toEqual({})
      expect(guard.record('run_command', { command: 'npm test' }, edits + 1)).toEqual({})
    }
  })
})
