import { describe, expect, it } from 'vitest'
import type { GoalEvaluateRequest } from '@shared/goal'
import type { CheckRun } from './checkRunner'
import { JUDGE_SYSTEM, evaluateGoal, parseJudgeAnswer, type GoalEvaluatorDeps } from './evaluator'

const run = (over: Partial<CheckRun> = {}): CheckRun => ({ exitCode: 0, output: '', timedOut: false, cancelled: false, durationMs: 10, ...over })

function deps(over: Partial<GoalEvaluatorDeps> & { checkRun?: CheckRun; answer?: string | Error } = {}): GoalEvaluatorDeps & { calls: string[] } {
  const calls: string[] = []
  const { checkRun, answer, ...rest } = over
  return {
    calls,
    workspace: 'C:\\project',
    runCheck: async (command, cwd) => { calls.push(`check ${command} in ${cwd}`); return checkRun ?? run() },
    ask: async (system, prompt) => {
      calls.push('ask')
      if (answer instanceof Error) throw answer
      expect(system).toBe(JUDGE_SYSTEM)
      expect(prompt).toContain('<record>')
      return answer ?? '{"met": true, "reason": "The tests ran and passed."}'
    },
    digest: () => '- run_command {"command":"npm test"}\n  returned (run_command): 12 passed',
    overBudget: () => undefined,
    ...rest
  }
}

const request = (over: Partial<GoalEvaluateRequest> = {}): GoalEvaluateRequest => ({ conversationId: 'c1', goal: { text: 'all tests pass' }, ...over })
const complete = { status: 'complete' as const, note: 'ran npm test: 12 passed' }

describe('with a check command', () => {
  it('is met when the command exits with 0, whatever the agent said', async () => {
    const d = deps()
    expect(await evaluateGoal(request({ goal: { text: 'it builds', check: 'npm run build' } }), d))
      .toEqual({ kind: 'met', reason: 'The check passed: npm run build' })
    expect(d.calls).toEqual(['check npm run build in C:\\project'])
  })

  it('goes on, with what the command printed, when it fails', async () => {
    const d = deps({ checkRun: run({ exitCode: 1, output: 'FAIL src/a.test.ts\n  expected 1 to be 2' }) })
    const verdict = await evaluateGoal(request({ goal: { text: 'tests pass', check: 'npm test' }, claim: complete }), d)
    expect(verdict).toMatchObject({ kind: 'continue', reason: 'The check failed with exit code 1: npm test' })
    expect(verdict.kind === 'continue' && verdict.detail).toContain('FAIL src/a.test.ts')
    // The agent said it was done and the command disagreed: the command wins, and no model is asked.
    expect(d.calls.some((call) => call === 'ask')).toBe(false)
  })

  it('does not treat a timeout as a pass even when the exit code reads 0', async () => {
    const verdict = await evaluateGoal(request({ goal: { text: 'g', check: 'x' } }), deps({ checkRun: run({ exitCode: 0, timedOut: true }) }))
    expect(verdict.kind).toBe('continue')
  })

  it('pauses (an error verdict) when the command cannot start, was cancelled, or has no folder to run in', async () => {
    const goal = { text: 'g', check: 'npm test' }
    expect(await evaluateGoal(request({ goal }), deps({ checkRun: run({ exitCode: null, startError: 'spawn ENOENT' }) })))
      .toEqual({ kind: 'error', reason: 'The check command could not start: spawn ENOENT' })
    expect(await evaluateGoal(request({ goal }), deps({ checkRun: run({ exitCode: null, cancelled: true }) }))).toMatchObject({ kind: 'error' })
    const noFolder = await evaluateGoal(request({ goal }), deps({ workspace: undefined }))
    expect(noFolder).toMatchObject({ kind: 'error' })
    expect(noFolder.reason).toContain('no project folder')
  })
})

describe('without a check command', () => {
  it('takes a blocked claim at its word', async () => {
    const d = deps()
    expect(await evaluateGoal(request({ claim: { status: 'blocked', note: 'Needs the staging API key.' } }), d))
      .toEqual({ kind: 'blocked', reason: 'Needs the staging API key.' })
    expect(await evaluateGoal(request({ claim: { status: 'blocked', note: '  ' } }), d)).toMatchObject({ kind: 'blocked', reason: 'The agent says it cannot go on without you.' })
    expect(d.calls).toEqual([])
  })

  it('asks a model when the agent says the goal is met, and is met when the model agrees', async () => {
    const d = deps()
    expect(await evaluateGoal(request({ claim: complete }), d)).toEqual({ kind: 'met', reason: 'The tests ran and passed.' })
    expect(d.calls).toEqual(['ask'])
  })

  it('pauses when the model fails or answers in a form it cannot read', async () => {
    const failed = await evaluateGoal(request({ claim: complete }), deps({ answer: new Error('429 rate limit') }))
    expect(failed).toMatchObject({ kind: 'error' })
    expect(failed.reason).toContain('429 rate limit')
    const garbled = await evaluateGoal(request({ claim: complete }), deps({ answer: 'I think so, yes.' }))
    expect(garbled).toMatchObject({ kind: 'error' })
    expect(garbled.reason).toContain('did not answer in the form')
  })
})

describe('spending caps', () => {
  it('ends the goal instead of asking a model when a cap has been reached', async () => {
    const d = deps({ overBudget: () => 'The session cap of $2.00 was reached.' })
    expect(await evaluateGoal(request({ claim: complete }), d)).toEqual({ kind: 'limit', reason: 'The session cap of $2.00 was reached.' })
    expect(d.calls).toEqual([])
  })
})

describe('the judge', () => {
  it('reads a verdict from a reply that wraps it', () => {
    expect(parseJudgeAnswer('{"met": true, "reason": " ok "}')).toEqual({ met: true, reason: 'ok' })
    expect(parseJudgeAnswer('Here you go: {"met": false} Thanks.')).toEqual({ met: false, reason: '' })
    expect(parseJudgeAnswer('```json\n{"met": false, "reason": "x"}\n```')).toEqual({ met: false, reason: 'x' })
  })
})
