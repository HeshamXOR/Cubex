import { describe, expect, it } from 'vitest'
import { StallDetector } from './stallDetector'

describe('noticing a model going round in circles', () => {
  it('notices the same error coming back from different attempts, whatever numbers it carries', () => {
    const stalls = new StallDetector()
    const attempt = (n: number): string | undefined =>
      stalls.record('run_command', { command: `npm test -- --seed ${n}` }, `Exit code: 1\n\nTypeError at line ${n}: x is not a function`, true, n)
    expect(attempt(1)).toBeUndefined()
    expect(attempt(2)).toBeUndefined()
    expect(attempt(3)).toContain('same error has now come back 3 times')
  })

  it('counts a command that reports failure in its output as a failure', () => {
    const stalls = new StallDetector()
    const failing = 'Exit code: 2\n\nmake: *** [all] Error 2'
    stalls.record('run_command', { command: 'make' }, failing, false, 0)
    stalls.record('run_command', { command: 'make all' }, failing, false, 1)
    expect(stalls.record('run_command', { command: 'make -j1' }, failing, false, 2)).toContain('same error')
    expect(new StallDetector().record('run_command', { command: 'make' }, 'Exit code: 0\n\nok', false, 0)).toBeUndefined()
  })

  it('notices a file read again and again without an edit, and forgets after one', () => {
    const stalls = new StallDetector()
    const read = (offset: number, edits = 0): string | undefined => stalls.record('read_file', { path: 'a.ts', offset }, 'text', false, edits)
    read(1); read(2); read(3)
    expect(read(4)).toContain('read a.ts 4 times')
    expect(read(5, 1)).toBeUndefined()
  })

  it('notices two actions taking turns', () => {
    const stalls = new StallDetector()
    const notes = [0, 1, 2, 3, 4, 5].map((i) => stalls.record(i % 2 ? 'glob_files' : 'list_files', { path: '.' }, 'same', false, 0))
    expect(notes[5]).toContain('alternating')
    expect(notes.slice(0, 5).every((note) => note === undefined)).toBe(true)
  })

  it('asks for a new plan from the second note on', () => {
    const stalls = new StallDetector()
    const failing = 'Exit code: 1\n\nboom'
    const notes = [0, 1, 2, 3, 4].map((i) => stalls.record('run_command', { command: `t${i}` }, failing, true, i))
    expect(notes[2]).not.toContain('different plan')
    expect(notes[4]).toContain('a different plan')
  })
})
