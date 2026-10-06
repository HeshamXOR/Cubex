import { describe, expect, it } from 'vitest'
import type { ErrorCategory } from '@core/types'
import { approvalBody, editedPaths, failedBody, finishedBody, oneLine, planBody, questionBody, toastTitle } from './copy'

describe('oneLine', () => {
  it('flattens whitespace and cuts with an ellipsis', () => {
    expect(oneLine('  a\n\n  b\tc  ', 50)).toBe('a b c')
    expect(oneLine('x'.repeat(30), 10)).toBe(`${'x'.repeat(9)}…`)
    expect(oneLine('short', 10)).toBe('short')
  })
})

describe('approvalBody', () => {
  it('turns a tool title into a sentence about what is being asked', () => {
    expect(approvalBody({ title: 'Run npm test' })).toBe('Needs your approval to run npm test')
    expect(approvalBody({ title: 'Edit src/app.ts (3 edits)' })).toBe('Needs your approval to edit src/app.ts (3 edits)')
    expect(approvalBody({ title: 'Fetch example.com' })).toBe('Needs your approval to fetch example.com')
    expect(approvalBody({ title: 'Write src/new.ts' })).toBe('Needs your approval to write src/new.ts')
  })

  it('keeps a title that is not a verb phrase whole', () => {
    expect(approvalBody({ title: 'github: create_issue' })).toBe('Needs your approval: github: create_issue')
  })

  it('shows a long multi-line command on one short line', () => {
    const body = approvalBody({ title: `Run ${'echo hello && '.repeat(30)}\nrm -rf build` })
    expect(body.startsWith('Needs your approval to run echo hello')).toBe(true)
    expect(body).not.toContain('\n')
    expect(body.length).toBeLessThanOrEqual('Needs your approval to '.length + 120)
  })

  it('has words for an empty title', () => {
    expect(approvalBody({ title: '' })).toBe('Needs your approval to continue')
  })
})

describe('questionBody and planBody', () => {
  it('quotes the question and names the plan', () => {
    expect(questionBody({ question: 'Which database\nshould I use?' })).toBe('Needs your answer: Which database should I use?')
    expect(questionBody({ question: '  ' })).toBe('Needs your answer')
    expect(planBody({ title: 'Add retry to uploads', plan: '1. x' })).toBe('Needs your review: Add retry to uploads')
    expect(planBody({ plan: '# Plan: split the client\n\n1. move it' })).toBe('Needs your review: Plan: split the client')
    expect(planBody({ plan: '' })).toBe('Needs your review of the plan')
  })
})

describe('finishedBody', () => {
  it('counts the files the turn changed', () => {
    expect(finishedBody(0)).toBe('Finished')
    expect(finishedBody(1)).toBe('Finished: 1 file changed')
    expect(finishedBody(3)).toBe('Finished: 3 files changed')
  })
})

describe('failedBody', () => {
  const categories: ErrorCategory[] = [
    'AUTHENTICATION_ERROR', 'AUTHORIZATION_ERROR', 'RATE_LIMIT_ERROR', 'INVALID_REQUEST', 'MODEL_NOT_FOUND', 'CONTEXT_LENGTH', 'CONTENT_POLICY',
    'NETWORK_ERROR', 'TIMEOUT', 'SERVER_ERROR', 'STREAM_ERROR', 'TOOL_ERROR', 'LOCAL_RUNTIME_ERROR', 'INSUFFICIENT_MEMORY', 'UNSUPPORTED_FORMAT', 'CANCELLED', 'UNKNOWN'
  ]

  it('says why in plain words for every category', () => {
    for (const category of categories) {
      const body = failedBody({ category, message: 'raw provider text' })
      expect(body.startsWith('Stopped: '), category).toBe(true)
      expect(body, category).not.toMatch(/_ERROR|undefined/)
    }
    expect(failedBody({ category: 'TIMEOUT' })).toBe('Stopped: the provider timed out')
    expect(failedBody({ category: 'RATE_LIMIT_ERROR' })).toBe('Stopped: the provider is rate limiting this key')
  })

  it('falls back to the provider text only when it cannot classify the failure', () => {
    expect(failedBody({ category: 'UNKNOWN', message: 'Socket hang up\nat net.Socket' })).toBe('Stopped: Socket hang up at net.Socket')
    expect(failedBody({ category: 'UNKNOWN', message: '' })).toBe('Stopped: the turn failed')
    expect(failedBody({ category: 'TIMEOUT', message: 'ETIMEDOUT 10.0.0.1' })).not.toContain('ETIMEDOUT')
  })
})

describe('editedPaths', () => {
  const call = (patch: Record<string, unknown>) => ({ id: 't1', name: 'edit_file', phase: 'done' as const, title: 'Edit src/a.ts', ...patch })

  it('names the file a finished edit touched', () => {
    expect(editedPaths(call({}))).toEqual(['src/a.ts'])
    expect(editedPaths(call({ name: 'write_file', title: 'Write src/new.ts' }))).toEqual(['src/new.ts'])
    expect(editedPaths(call({ name: 'multi_edit', title: 'Edit src/a.ts (2 edits)' }))).toEqual(['src/a.ts'])
    expect(editedPaths(call({ name: 'remove_file', title: 'Remove old.txt' }))).toEqual(['old.txt'])
  })

  it('lists every file of a patch', () => {
    expect(editedPaths(call({ name: 'apply_patch', title: 'Patch 2 files', files: [{ path: 'a.ts', status: 'modified', added: 1, removed: 0 }, { path: 'b.ts', status: 'added', added: 4, removed: 0 }] }))).toEqual(['a.ts', 'b.ts'])
  })

  it('still counts a call whose file it cannot name, once', () => {
    expect(editedPaths(call({ name: 'apply_patch', title: 'Patch 3 files' }))).toEqual(['call:t1'])
    expect(editedPaths(call({ title: undefined }))).toEqual(['call:t1'])
  })

  it('ignores anything that did not change a file', () => {
    expect(editedPaths(call({ phase: 'error' }))).toEqual([])
    expect(editedPaths(call({ phase: 'running' }))).toEqual([])
    expect(editedPaths(call({ name: 'read_file', title: 'Read src/a.ts' }))).toEqual([])
    expect(editedPaths(call({ name: 'run_command', title: 'Run npm test' }))).toEqual([])
  })
})

describe('toastTitle', () => {
  it('uses the session title, or the app name for an unnamed session', () => {
    expect(toastTitle('Retry uploads on 429')).toBe('Retry uploads on 429')
    expect(toastTitle(undefined)).toBe('Cubex')
    expect(toastTitle('New Chat')).toBe('Cubex')
    expect(toastTitle('New conversation')).toBe('Cubex')
    expect(toastTitle('  ')).toBe('Cubex')
    expect(toastTitle('x'.repeat(200)).length).toBe(80)
  })
})
