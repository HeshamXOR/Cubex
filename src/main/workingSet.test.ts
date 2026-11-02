import { describe, expect, it } from 'vitest'
import { WorkingSetTracker } from './workingSet'

describe('WorkingSetTracker', () => {

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
})
