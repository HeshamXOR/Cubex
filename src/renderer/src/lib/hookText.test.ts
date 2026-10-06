import { describe, expect, it } from 'vitest'
import type { HookTestResult } from '../../../shared/policy'
import { describeHookTrigger, explainHookTest, folderLabel } from './hookText'

const result = (over: Partial<HookTestResult>): HookTestResult => ({
  event: 'PreToolUse', command: 'x', cwd: 'C:\\p', cwdKind: 'project', payload: '{}', outcome: 'ran', exitCode: 0,
  durationMs: 12, stdout: '', stderr: '', truncated: false, decision: 'allowed', ...over
})

describe('explainHookTest', () => {
  it('calls a clean PreToolUse run allowed', () => {
    expect(explainHookTest(result({}))).toEqual({ tone: 'ok', title: 'Allowed', body: 'The hook exited with code 0, so the tool would run.' })
  })

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

  it('names a missing exit code', () => {
    expect(explainHookTest(result({ exitCode: null })).body).toContain('It ended with no exit code')
  })

  it('says a timeout never blocks', () => {
    expect(explainHookTest(result({ outcome: 'timed-out', exitCode: null }))).toEqual({
      tone: 'warn',
      title: 'The hook timed out',
      body: 'It was stopped after 10 seconds. A hook that times out never blocks anything, so the tool would still run.'
    })
    expect(explainHookTest(result({ event: 'Stop', outcome: 'timed-out', exitCode: null })).body).toContain('the session would carry on')
  })

  it('reports a command that never started as an error', () => {
    expect(explainHookTest(result({ outcome: 'failed-to-start', exitCode: null, startError: 'spawn cmd.exe ENOENT' }))).toEqual({
      tone: 'error', title: 'The hook did not start', body: 'spawn cmd.exe ENOENT'
    })
    expect(explainHookTest(result({ outcome: 'failed-to-start', exitCode: null })).body).toBe('The shell could not start the command.')
  })

  it('explains an event that cannot block', () => {
    expect(explainHookTest(result({ event: 'PostToolUse' }))).toEqual({
      tone: 'ok', title: 'Ran without errors', body: 'PostToolUse hooks cannot block anything, so this only shows that the command works.'
    })
    expect(explainHookTest(result({ event: 'PostToolUse', exitCode: 2, blockIgnored: true }))).toEqual({
      tone: 'warn', title: 'Ran, and asked to block', body: 'PostToolUse hooks cannot block anything, so Cubex ignores the request.'
    })
    expect(explainHookTest(result({ event: 'UserPromptSubmit', exitCode: 1 }))).toEqual({
      tone: 'warn', title: 'The hook failed', body: 'It ended with exit code 1. Cubex ignores the result of UserPromptSubmit hooks.'
    })
  })
})

describe('folderLabel', () => {
  it('tells the project from the temporary folder', () => {
    expect(folderLabel({ cwdKind: 'project' })).toBe('Project folder')
    expect(folderLabel({ cwdKind: 'scratch' })).toBe('Empty temporary folder')
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

  it('ignores a matcher on an event that has no tool', () => {
    expect(text('Stop', 'write_file')).toBe('When a turn ends')
    expect(text('UserPromptSubmit', 'write_file')).toBe('When you send a message')
  })
})
