import { describe, expect, it } from 'vitest'
import type { PermissionAsk } from '../../../shared/ipc'
import type { DelegateActivity } from '../../../shared/peers'
import { delegateAgentOf, delegateAsk, delegateRow, previewLines, reportHeading, STEP_SPOKEN, stepView, untrackedNote } from './delegateText'

const activity = (over: Partial<DelegateActivity> = {}): DelegateActivity => ({ name: 'Codex', role: 'implement', status: 'working', steps: [], files: [], ...over })

describe('the row of a task in the thread', () => {
  it('says the role, the files and how long it took', () => {
    const view = delegateRow(activity({ status: 'done', seconds: 125, files: [{ path: 'a.ts', change: 'edited', tracked: true }, { path: 'b.ts', change: 'created', tracked: true }] }))
    expect(view.meta).toBe('Implement, 2 files, 2m 5s')
    expect(view.step).toBeUndefined()
    expect(view.ended).toBeUndefined()
  })

  it('names one file in the singular and leaves out what is not known', () => {
    expect(delegateRow(activity({ role: 'review', files: [{ path: 'a.ts', change: 'edited', tracked: false }] })).meta).toBe('Review, 1 file')
    expect(delegateRow(activity({ role: 'test' })).meta).toBe('Run tests')
  })

  it('shows what the agent is doing while it works: the step in progress', () => {
    const view = delegateRow(activity({ steps: [{ title: 'Read src/a.ts', kind: 'read', state: 'done' }, { title: 'Run npm test', kind: 'execute', state: 'running' }, { title: 'Edit b.ts', kind: 'edit', state: 'done' }] }))
    expect(view.step).toBe('Run npm test')
  })

  it('falls back to the last step when none is in progress, and shows none once the task is over', () => {
    const steps = [{ title: 'Read src/a.ts', kind: 'read', state: 'done' as const }, { title: 'Edit b.ts', kind: 'edit', state: 'done' as const }]
    expect(delegateRow(activity({ steps })).step).toBe('Edit b.ts')
    expect(delegateRow(activity({ status: 'waiting', steps })).step).toBe('Edit b.ts')
    expect(delegateRow(activity({ status: 'done', steps })).step).toBeUndefined()
  })

  it('has a word for an ending that is not a success', () => {
    expect(delegateRow(activity({ status: 'failed' })).ended).toBe('Failed')
    expect(delegateRow(activity({ status: 'cancelled' })).ended).toBe('Cancelled')
    expect(delegateRow(activity({ status: 'done' })).ended).toBeUndefined()
  })
})

describe('what is said about files nobody asked about', () => {
  it('is nothing when every change was kept', () => {
    expect(untrackedNote([{ path: 'a.ts', change: 'edited', tracked: true }])).toBeUndefined()
    expect(untrackedNote([])).toBeUndefined()
  })

  it('says Rewind cannot undo them', () => {
    expect(untrackedNote([{ path: 'a.ts', change: 'edited', tracked: true }, { path: 'dist/x.js', change: 'created', tracked: false }]))
      .toBe('The file marked not kept was changed without Cubex being asked, so it saved no copy and Rewind cannot undo it.')
    expect(untrackedNote([{ path: 'a', change: 'edited', tracked: false }, { path: 'b', change: 'created', tracked: false }]))
      .toBe('The 2 files marked not kept were changed without Cubex being asked, so it saved no copy and Rewind cannot undo them.')
  })
})

describe('the heading over what the agent said', () => {
  it('is a report when it finished, and what happened when it did not', () => {
    expect(reportHeading(activity({ status: 'done' }))).toBe('Report')
    expect(reportHeading(activity({ status: 'failed' }))).toBe('What happened')
    expect(reportHeading(activity({ status: 'cancelled' }))).toBe('What happened')
  })
})

describe('how a step is drawn', () => {
  const running = { title: 'Run npm test', kind: 'execute', state: 'running' as const }

  it('is as working only while the task works or waits for you', () => {
    expect(stepView(activity({ status: 'working' }), running)).toBe('running')
    expect(stepView(activity({ status: 'waiting' }), running)).toBe('running')
  })

  it('is as not finished when the task ended with the step still in progress', () => {
    for (const status of ['done', 'failed', 'cancelled'] as const) expect(stepView(activity({ status }), running)).toBe('stopped')
    expect(STEP_SPOKEN.stopped).toBe(', did not finish')
  })

  it('keeps a step that finished or failed as it is', () => {
    expect(stepView(activity({ status: 'cancelled' }), { ...running, state: 'done' })).toBe('done')
    expect(stepView(activity({ status: 'working' }), { ...running, state: 'failed' })).toBe('failed')
    expect(STEP_SPOKEN.done).toBe('')
  })
})

describe('the lines of a change', () => {
  it('are tagged by what happened to them', () => {
    expect(previewLines('-old\n+new\n same')).toEqual([{ tag: '-', text: 'old' }, { tag: '+', text: 'new' }, { tag: ' ', text: 'same' }])
  })

  it('turn a gap marker into a plain line', () => {
    expect(previewLines('@12 more lines')).toEqual([{ tag: ' ', text: '… 12 more lines' }])
  })

  it('stop at forty lines and say how many are left', () => {
    const lines = previewLines(Array.from({ length: 55 }, (_, index) => `+line ${index}`).join('\n'))
    expect(lines).toHaveLength(41)
    expect(lines[40]).toEqual({ tag: ' ', text: '… 15 more lines' })
  })
})

describe('the question about handing over a task', () => {
  const ask = (over: Partial<PermissionAsk> = {}): PermissionAsk => ({ id: 'a1', toolName: 'delegate_task', title: 'Delegate to Codex', detail: 'To Codex (implement):\n\nFix the parser bug.\nRun the tests.', ...over })

  it('names the agent, the kind of task, and has the task as it will be read', () => {
    expect(delegateAsk(ask())).toEqual({ heading: 'Hand this task to Codex?', target: 'Implement', body: 'Fix the parser bug.\nRun the tests.' })
    expect(delegateAgentOf(ask())).toBe('Codex')
  })

  it('knows the other kinds of task', () => {
    expect(delegateAsk(ask({ detail: 'To Gemini CLI (review):\n\nLook for races.' }))).toMatchObject({ heading: 'Hand this task to Gemini CLI?', target: 'Review' })
    expect(delegateAsk(ask({ detail: 'To X (test):\n\nRun them.' }))).toMatchObject({ target: 'Run tests' })
  })

  it('keeps an agent name that holds brackets', () => {
    expect(delegateAsk(ask({ detail: 'To Codex (beta) (implement):\n\nDo it.' }))).toMatchObject({ heading: 'Hand this task to Codex (beta)?' })
  })

  it('shows what it was sent when it is not in the usual shape', () => {
    expect(delegateAsk(ask({ detail: 'something else' }))).toEqual({ heading: 'Allow Delegate to Codex?', body: 'something else' })
    expect(delegateAsk(ask({ detail: undefined, title: '' }))).toEqual({ heading: 'Allow this task?' })
  })

  it('is not about any other tool', () => {
    expect(delegateAsk({ id: 'a', toolName: 'run_command', title: 'Run' })).toBeUndefined()
    expect(delegateAgentOf({ id: 'a', toolName: 'run_command', title: 'Run' })).toBeUndefined()
  })
})

describe('the questions an agent asks while it works', () => {
  const step = (action: NonNullable<PermissionAsk['delegate']>['action'], over: Partial<NonNullable<PermissionAsk['delegate']>> = {}, ask: Partial<PermissionAsk> = {}): PermissionAsk =>
    ({ id: 'a2', toolName: 'delegate_task', title: `Codex wants to ${action}`, delegate: { agent: 'Codex', action, ...over }, ...ask })

  it('shows an edit as the change, and says Rewind can undo it', () => {
    expect(delegateAsk(step('edit', { target: 'src/a.ts' }, { detail: '-old\n+new' }))).toEqual({
      heading: 'Codex wants to edit this file?', target: 'src/a.ts', preview: [{ tag: '-', text: 'old' }, { tag: '+', text: 'new' }], note: 'Rewind can undo it.'
    })
    expect(delegateAgentOf(step('edit'))).toBe('Codex')
  })

  it('asks about a delete and a move by the file', () => {
    expect(delegateAsk(step('delete', { target: 'old.ts' }))).toEqual({ heading: 'Codex wants to delete this file?', target: 'old.ts', note: 'Rewind can undo it.' })
    expect(delegateAsk(step('move', { target: 'a.ts to b.ts' }))).toMatchObject({ heading: 'Codex wants to move this file?', target: 'a.ts to b.ts' })
  })

  it('shows a command as the command, and says Rewind cannot undo what it does', () => {
    expect(delegateAsk(step('run', { command: 'npm test' }))).toEqual({ heading: 'Codex wants to run this command?', command: 'npm test', note: 'Rewind can\'t undo what a command changes.' })
    expect(delegateAsk(step('run', {}, { detail: 'npm run build' }))).toMatchObject({ command: 'npm run build' })
  })

  it('shows a page it wants to fetch', () => {
    expect(delegateAsk(step('fetch', { target: 'https://example.com' }, { detail: 'GET https://example.com' }))).toEqual({
      heading: 'Codex wants to fetch this page?', target: 'https://example.com', body: 'GET https://example.com'
    })
  })

  it('says what a tool it does not know is for', () => {
    expect(delegateAsk(step('other', {}, { title: 'Codex wants to use a tool: Browser', detail: 'Open a page' }))).toEqual({ heading: 'Codex wants to use a tool: Browser?', body: 'Open a page' })
  })
})
