import { describe, expect, it } from 'vitest'
import { WORKING_SET_MAX_CHARS, WorkingSetTracker } from './workingSet'

describe('WorkingSetTracker', () => {
  it('has nothing to say for a conversation it has not seen', () => {
    expect(new WorkingSetTracker().render('c1')).toBeUndefined()
  })

  it('names the todos, the plan and the files, edited before read, newest first', () => {
    const set = new WorkingSetTracker()
    set.setTodos('c1', [{ content: 'Add retry', status: 'in_progress' }, { content: 'Write tests', status: 'pending' }])
    set.noteRead('c1', 'src/a.ts')
    set.noteRead('c1', 'src/b.ts')
    set.noteEdit('c1', 'src/c.ts')
    set.noteEdit('c1', 'src/a.ts')
    set.setPlan('c1', '1. do it', 'Retry plan')
    const text = set.render('c1')!
    expect(text).toContain('[in progress] Add retry')
    expect(text).toContain('[pending] Write tests')
    expect(text).toContain('Active plan: Retry plan')
    expect(text).toContain('Files edited: src/a.ts, src/c.ts')
    expect(text).toContain('Files read: src/b.ts')
  })

  it('keeps at most 30 files and stays under 1,500 characters', () => {
    const set = new WorkingSetTracker()
    set.setTodos('c1', Array.from({ length: 40 }, (_, i) => ({ content: `Step ${i} ${'x'.repeat(200)}`, status: 'pending' as const })))
    for (let i = 0; i < 60; i++) set.noteRead('c1', `src/very/long/path/to/some/module-number-${i}.ts`)
    const text = set.render('c1')!
    expect(text.length).toBeLessThanOrEqual(WORKING_SET_MAX_CHARS)
    expect(text.match(/module-number-/g)!.length).toBeLessThanOrEqual(30)
  })

  it('lists only the newest 30 files when there is room', () => {
    const set = new WorkingSetTracker()
    for (let i = 0; i < 60; i++) set.noteRead('c1', `f${i}.ts`)
    const text = set.render('c1')!
    expect(text.match(/f\d+\.ts/g)!.length).toBe(30)
    expect(text).toContain('f59.ts')
    expect(text).not.toContain('f29.ts')
    expect(text.length).toBeLessThanOrEqual(WORKING_SET_MAX_CHARS)
  })

  it('forgets a conversation', () => {
    const set = new WorkingSetTracker()
    set.noteRead('c1', 'a.ts')
    set.forget('c1')
    expect(set.render('c1')).toBeUndefined()
  })
})
