import { describe, expect, it } from 'vitest'
import type { HookTestResult } from '../../../shared/policy'
import { describeHookTrigger, explainHookTest } from './hookText'

const result = (over: Partial<HookTestResult>): HookTestResult => ({
  event: 'PreToolUse', command: 'x', cwd: 'C:\\p', cwdKind: 'project', payload: '{}', outcome: 'ran', exitCode: 0,
  durationMs: 12, stdout: '', stderr: '', truncated: false, decision: 'allowed', ...over
})

describe('explainHookTest', () => {

  it('calls a block a block, in the attention color', () => {
    expect(explainHookTest(result({ decision: 'blocked', exitCode: 2, reason: 'no' }))).toEqual({
      tone: 'warn', title: 'Blocked', body: 'This hook would stop the tool from running.'
    })
  })

  it('says a crashing guard guards nothing, and what does stop a tool', () => {
    const verdict = explainHookTest(result({ exitCode: 1 }))
    expect(verdict.tone).toBe('warn')
    expect(verdict.title).toBe('Allowed, but the hook failed')
    expect(verdict.body).toBe('It ended with exit code 1, which is not a block, so the tool would still run. Only exit code 2, or a printed {"decision":"block"}, stops a tool.')
  })

  it('says a timeout never blocks', () => {
    expect(explainHookTest(result({ outcome: 'timed-out', exitCode: null }))).toEqual({
      tone: 'warn',
      title: 'The hook timed out',
      body: 'It was stopped after 10 seconds. A hook that times out never blocks anything, so the tool would still run.'
    })
    expect(explainHookTest(result({ event: 'Stop', outcome: 'timed-out', exitCode: null })).body).toContain('the turn would end')
  })

})

describe('describeHookTrigger', () => {
  const text = (event: Parameters<typeof describeHookTrigger>[0], matcher?: string): string => describeHookTrigger(event, matcher).map((part) => part.text).join('')

  it('says when a hook runs', () => {
    expect(text('PreToolUse')).toBe('Before any tool runs')
    expect(text('PostToolUse', '')).toBe('After any tool runs')
    expect(text('PreToolUse', ' | ')).toBe('Before any tool runs')
    expect(text('UserPromptSubmit')).toBe('When you send a message')
    expect(text('Stop')).toBe('When a turn ends')
  })

  it('names the tools a matcher picks, listing alternatives', () => {
    expect(text('PreToolUse', 'write_file')).toBe('Before a tool matching write_file runs')
    expect(text('PostToolUse', 'write_file|edit_file')).toBe('After a tool matching write_file or edit_file runs')
    expect(text('PreToolUse', 'a|b|c')).toBe('Before a tool matching a, b or c runs')
    expect(describeHookTrigger('PreToolUse', 'a|b').filter((part) => part.code).map((part) => part.text)).toEqual(['a', 'b'])
  })

})
