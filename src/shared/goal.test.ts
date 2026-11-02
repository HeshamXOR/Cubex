import { describe, expect, it } from 'vitest'
import {
  GOAL_LIMITS, addGoalTokens, applyVerdict, formatTokens, normalizeStoredGoal, parseTokenCount, restoreGoal, storableGoal, usageTokens, clampTurns, goalContinuation, goalKickoff, goalPrompt, normalizeGoalRequest, parseGoalCommand,
  parseGoalEvaluateRequest, parseGoalMessage, pauseGoal, resumeGoal, startGoal, withNote, type Goal
} from './goal'

const active = (over: Partial<Goal> = {}): Goal => ({ ...startGoal('all tests pass', undefined, 5), ...over })

describe('parseGoalCommand', () => {
  it('shows the goal for a bare command, and reads the three controls in any case', () => {
    expect(parseGoalCommand('')).toEqual({ kind: 'status' })
    expect(parseGoalCommand('   ')).toEqual({ kind: 'status' })
    expect(parseGoalCommand('pause')).toEqual({ kind: 'pause' })
    expect(parseGoalCommand(' Resume ')).toEqual({ kind: 'resume' })
    expect(parseGoalCommand('CLEAR')).toEqual({ kind: 'clear' })
  })

  it('takes anything else as the goal, so the words of a goal are never mistaken for a command', () => {
    expect(parseGoalCommand('all tests in packages/api pass')).toEqual({ kind: 'start', text: 'all tests in packages/api pass' })
    expect(parseGoalCommand('check the logs for errors')).toEqual({ kind: 'start', text: 'check the logs for errors' })
    expect(parseGoalCommand('clear the backlog of bugs')).toEqual({ kind: 'start', text: 'clear the backlog of bugs' })
    expect(parseGoalCommand('pause menu works')).toEqual({ kind: 'start', text: 'pause menu works' })
  })

  it('reads a check command after --check', () => {
    expect(parseGoalCommand('all tests pass --check npm test')).toEqual({ kind: 'start', text: 'all tests pass', check: 'npm test' })
    expect(parseGoalCommand('it builds   --check   npm run build  ')).toEqual({ kind: 'start', text: 'it builds', check: 'npm run build' })
    expect(parseGoalCommand('lint is clean --check npx eslint . --ext .ts')).toEqual({ kind: 'start', text: 'lint is clean', check: 'npx eslint . --ext .ts' })
  })

  it('does not take --check inside a word as the flag', () => {
    expect(parseGoalCommand('add a --checkpoint option')).toEqual({ kind: 'start', text: 'add a --checkpoint option' })
  })

  it('says what is wrong, with an example, when the flag is misused', () => {
    expect(parseGoalCommand('--check npm test')).toMatchObject({ kind: 'invalid', error: expect.stringContaining('Say what done means') })
    expect(parseGoalCommand('it works --check')).toMatchObject({ kind: 'invalid', error: expect.stringContaining('Name the command') })
    expect(parseGoalCommand('it works --check   ')).toMatchObject({ kind: 'invalid', error: expect.stringContaining('Name the command') })
    expect(parseGoalCommand('it works --check npm test\nrm -rf x')).toEqual({ kind: 'invalid', error: 'The check command must be one line.' })
  })

  it('refuses a goal or a command longer than the limits', () => {
    const long = parseGoalCommand('x'.repeat(GOAL_LIMITS.text + 1))
    expect(long).toMatchObject({ kind: 'invalid' })
    expect(long.kind === 'invalid' && long.error).toContain('2,000')
    expect(parseGoalCommand(`ok --check ${'y'.repeat(GOAL_LIMITS.check + 1)}`)).toMatchObject({ kind: 'invalid', error: expect.stringContaining('1,000') })
    expect(parseGoalCommand('x'.repeat(GOAL_LIMITS.text))).toMatchObject({ kind: 'start' })
  })
})

describe('normalizeGoalRequest', () => {
  it('keeps a bounded goal and its check', () => {
    expect(normalizeGoalRequest({ text: ' ship it ', check: ' npm test ' })).toEqual({ text: 'ship it', check: 'npm test' })
    expect(normalizeGoalRequest({ text: 'ship it' })).toEqual({ text: 'ship it' })
  })

  it('drops what is not a goal, and a check that is not one line or is too long', () => {
    for (const bad of [undefined, null, 'x', [], {}, { text: '' }, { text: '   ' }, { text: 4 }, { text: 'x'.repeat(GOAL_LIMITS.text + 1) }]) {
      expect(normalizeGoalRequest(bad)).toBeUndefined()
    }
    expect(normalizeGoalRequest({ text: 'a', check: 'npm test\nmore' })).toEqual({ text: 'a' })
    expect(normalizeGoalRequest({ text: 'a', check: 'c'.repeat(GOAL_LIMITS.check + 1) })).toEqual({ text: 'a' })
    expect(normalizeGoalRequest({ text: 'a', check: 5 })).toEqual({ text: 'a' })
  })
})

describe('starting and pausing', () => {
  it('starts active on its first turn, and keeps the turn limit between 1 and 50', () => {
    expect(startGoal('done', 'npm test')).toEqual({ text: 'done', check: 'npm test', status: 'active', turns: 1, maxTurns: 15, idle: 0 })
    expect(startGoal('done', undefined)).not.toHaveProperty('check')
    expect(clampTurns(0)).toBe(1)
    expect(clampTurns(500)).toBe(50)
    expect(clampTurns(7.6)).toBe(8)
    expect(clampTurns(Number.NaN)).toBe(15)
  })

  it('pauses with a note and drops what belonged to the turn', () => {
    const paused = pauseGoal(active({ claim: { status: 'complete', note: 'x' }, checking: true }))
    expect(paused).toMatchObject({ status: 'paused', note: 'No more turns start until you resume.' })
    expect(paused).not.toHaveProperty('claim')
    expect(paused).not.toHaveProperty('checking')
  })

  it('shows a note on one line', () => {
    expect(withNote(active(), 'first\n\n  second').note).toBe('first second')
    expect(withNote(active({ note: 'old' }), undefined)).not.toHaveProperty('note')
  })
})

describe('applyVerdict', () => {
  const none = { toolCalls: 3 }

  it('completes when the goal is met, and clears what belonged to the turn', () => {
    const step = applyVerdict(active({ claim: { status: 'complete', note: 'ran npm test' }, checking: true }), { kind: 'met', reason: 'The check passed.' }, none)
    expect(step.goal).toMatchObject({ status: 'complete', note: 'The check passed.', turns: 1 })
    expect(step.goal).not.toHaveProperty('claim')
    expect(step.goal).not.toHaveProperty('checking')
    expect(step.send).toBeUndefined()
  })

  it('stops, without a message, when blocked, at a limit, or when the turn could not be judged', () => {
    expect(applyVerdict(active(), { kind: 'blocked', reason: 'Needs the API key.' }, none)).toEqual({ goal: expect.objectContaining({ status: 'blocked', note: 'Needs the API key.' }) })
    expect(applyVerdict(active(), { kind: 'limit', reason: 'The session cap was reached.' }, none).goal.status).toBe('limit')
    const failed = applyVerdict(active(), { kind: 'error', reason: 'The check could not start.' }, none)
    expect(failed.goal).toMatchObject({ status: 'paused', note: 'The check could not start.' })
    expect(failed.send).toBeUndefined()
  })

  it('sends the agent back to work when the goal is not met, counting the turn', () => {
    const step = applyVerdict(active({ turns: 2 }), { kind: 'continue', reason: 'The check failed with exit code 1.', detail: '2 tests failed' }, none)
    expect(step.goal).toMatchObject({ status: 'active', turns: 3, idle: 0, note: 'The check failed with exit code 1.' })
    expect(step.send).toBeDefined()
    expect(parseGoalMessage(step.send!)).toEqual({ turn: 3, of: 5, reason: 'The check failed with exit code 1.' })
    expect(step.send).toContain('2 tests failed')
    expect(step.send).toContain('goal_update')
  })

  it('counts a turn with no tool call and no claim as idle, and calls the goal stalled on the second', () => {
    const first = applyVerdict(active(), { kind: 'continue', reason: 'It said nothing.' }, { toolCalls: 0 })
    expect(first.goal).toMatchObject({ status: 'active', idle: 1 })
    expect(first.send).toBeDefined()
    const second = applyVerdict(first.goal, { kind: 'continue', reason: 'It said nothing.' }, { toolCalls: 0 })
    expect(second.goal.status).toBe('stalled')
    expect(second.send).toBeUndefined()
  })

  it('does not count a turn as idle when it did work or said something about the goal', () => {
    expect(applyVerdict(active({ idle: 1 }), { kind: 'continue', reason: 'r' }, { toolCalls: 2 }).goal.idle).toBe(0)
    expect(applyVerdict(active({ idle: 1, claim: { status: 'complete', note: 'done' } }), { kind: 'continue', reason: 'r' }, { toolCalls: 0 }).goal.idle).toBe(0)
  })

  it('stops at the turn limit, and says how many turns it took', () => {
    const step = applyVerdict(active({ turns: 5, maxTurns: 5 }), { kind: 'continue', reason: 'Two tests still fail.' }, none)
    expect(step.goal.status).toBe('limit')
    expect(step.goal.note).toBe('Stopped after 5 turns. Two tests still fail.')
    expect(step.send).toBeUndefined()
    expect(applyVerdict(active({ turns: 1, maxTurns: 1 }), { kind: 'continue', reason: 'r' }, none).goal.note).toContain('Stopped after 1 turn.')
  })
})

describe('resumeGoal', () => {
  it('makes a paused goal active and sends the agent a message for the next turn', () => {
    const step = resumeGoal(pauseGoal(active({ turns: 2 })))
    expect(step.goal).toMatchObject({ status: 'active', turns: 3, idle: 0 })
    expect(step.goal).not.toHaveProperty('note')
    expect(parseGoalMessage(step.send!)).toEqual({ turn: 3, of: 5, reason: 'You resumed the goal.' })
  })

  it('gives a goal that reached its limit another allowance from where it stopped', () => {
    const step = resumeGoal(active({ status: 'limit', turns: 5, maxTurns: 5 }))
    expect(step.goal).toMatchObject({ status: 'active', turns: 6, maxTurns: 20 })
  })

  it('leaves a completed goal alone', () => {
    const done = active({ status: 'complete' })
    expect(resumeGoal(done)).toEqual({ goal: done })
  })
})

describe('the messages', () => {
  it('opens a goal with an ordinary message', () => {
    expect(goalKickoff('all tests pass')).toBe('Goal: all tests pass')
    expect(parseGoalMessage(goalKickoff('all tests pass'))).toBeUndefined()
  })

  it('reads back what it wrote, and only that', () => {
    const text = goalContinuation(4, 15, 'The check failed.\n\nSecond paragraph.', 'FAIL src/a.test.ts\n  expected 1 to be 2')
    expect(parseGoalMessage(text)).toEqual({ turn: 4, of: 15, reason: 'The check failed. Second paragraph.' })
    expect(text).toContain('FAIL src/a.test.ts')
    for (const other of ['', 'hello', '<goal_check turn="1" of="2">\nno close tag', 'x<goal_check turn="1" of="2">\nr\n</goal_check>', '<goal_check turn="a" of="2">\nr\n</goal_check>']) {
      expect(parseGoalMessage(other)).toBeUndefined()
    }
  })

  it('cuts what a failed check printed to a bounded size', () => {
    const text = goalContinuation(2, 5, 'The check failed.', 'z'.repeat(GOAL_LIMITS.detail * 3))
    expect(text.length).toBeLessThan(GOAL_LIMITS.detail + 600)
  })
})

describe('what the agent is told', () => {
  it('states the goal, how to say it is met, and how to say it is blocked', () => {
    const prompt = goalPrompt({ text: 'all tests pass' })
    expect(prompt).toContain('all tests pass')
    expect(prompt).toContain('goal_update')
    expect(prompt).toContain('status "complete"')
    expect(prompt).toContain('status "blocked"')
    expect(prompt).not.toContain('Cubex also runs this command')
  })

  it('names the check command, which the agent must make pass and not change', () => {
    const prompt = goalPrompt({ text: 'it builds', check: 'npm run build' })
    expect(prompt).toContain('Cubex also runs this command after every turn: npm run build')
    expect(prompt).toContain('do not edit it')
  })
})

describe('parseGoalEvaluateRequest', () => {
  it('accepts a goal with an optional claim', () => {
    expect(parseGoalEvaluateRequest({ conversationId: 'c1', goal: { text: 'g', check: 'npm test' }, claim: { status: 'complete', note: 'ran it' } }))
      .toEqual({ conversationId: 'c1', goal: { text: 'g', check: 'npm test' }, claim: { status: 'complete', note: 'ran it' } })
    expect(parseGoalEvaluateRequest({ conversationId: 'c1', goal: { text: 'g' } })).toEqual({ conversationId: 'c1', goal: { text: 'g' } })
    expect(parseGoalEvaluateRequest({ conversationId: 'c1', goal: { text: 'g' }, claim: null })).not.toHaveProperty('claim')
  })

  it('bounds a claim note and refuses what is not a request', () => {
    const long = parseGoalEvaluateRequest({ conversationId: 'c1', goal: { text: 'g' }, claim: { status: 'blocked', note: 'n'.repeat(5000) } })
    expect(long.claim?.note).toHaveLength(GOAL_LIMITS.note)
    for (const bad of [null, 'x', [], {}, { conversationId: 1, goal: { text: 'g' } }, { conversationId: '', goal: { text: 'g' } },
      { conversationId: 'c', goal: {} }, { conversationId: 'c', goal: { text: 'g' }, claim: { status: 'maybe', note: 'x' } },
      { conversationId: 'c', goal: { text: 'g' }, claim: { status: 'complete' } }]) {
      expect(() => parseGoalEvaluateRequest(bad)).toThrow()
    }
  })
})

describe('parseTokenCount and formatTokens', () => {
  it('reads plain numbers and k or m suffixes, and refuses anything else', () => {
    expect(parseTokenCount('200000')).toBe(200_000)
    expect(parseTokenCount('200k')).toBe(200_000)
    expect(parseTokenCount('200K')).toBe(200_000)
    expect(parseTokenCount('1.5m')).toBe(1_500_000)
    expect(parseTokenCount('2x')).toBeUndefined()
    expect(parseTokenCount('-5k')).toBeUndefined()
    expect(parseTokenCount('')).toBeUndefined()
  })

  it('writes counts short', () => {
    expect([950, 1_500, 38_000, 212_400, 999_700, 1_200_000].map(formatTokens)).toEqual(['950', '1.5k', '38k', '212k', '1m', '1.2m'])
  })
})

describe('/goal --budget', () => {
  it('reads a budget before --check, after the command, or alone', () => {
    expect(parseGoalCommand('all tests pass --budget 200k --check npm test')).toEqual({ kind: 'start', text: 'all tests pass', check: 'npm test', budget: 200_000 })
    expect(parseGoalCommand('all tests pass --check npm test --budget 1.5m')).toEqual({ kind: 'start', text: 'all tests pass', check: 'npm test', budget: 1_500_000 })
    expect(parseGoalCommand('it builds --budget 50000')).toEqual({ kind: 'start', text: 'it builds', budget: 50_000 })
    expect(parseGoalCommand('--budget 50k it builds')).toEqual({ kind: 'start', text: 'it builds', budget: 50_000 })
  })

  it('says what is wrong with a budget, with an example', () => {
    expect(parseGoalCommand('it builds --budget')).toMatchObject({ kind: 'invalid', error: expect.stringContaining('Give a number of tokens') })
    expect(parseGoalCommand('it builds --budget lots')).toMatchObject({ kind: 'invalid', error: expect.stringContaining('is not a token count') })
    expect(parseGoalCommand('it builds --budget 10')).toMatchObject({ kind: 'invalid', error: expect.stringContaining('between 1,000') })
    expect(parseGoalCommand('--budget 5k')).toMatchObject({ kind: 'invalid', error: expect.stringContaining('Say what done means') })
  })

  it('leaves similar words in the goal alone', () => {
    expect(parseGoalCommand('stay within the --budgetary limits')).toEqual({ kind: 'start', text: 'stay within the --budgetary limits' })
  })

  it('stops a goal that went over the budget, and gives it a fresh allowance when resumed', () => {
    const goal = { ...startGoal('x', undefined, 5, 200_000), tokens: 212_400, turning: true }
    const step = applyVerdict(goal, { kind: 'continue', reason: 'Not yet.' }, { toolCalls: 2 })
    expect(step.goal).toMatchObject({ status: 'limit', note: 'Used 212k of the 200k token budget.' })
    expect(step.send).toBeUndefined()
    const resumed = resumeGoal(step.goal)
    expect(resumed.goal).toMatchObject({ status: 'active', budget: 412_400 })
  })

  it('does not stop a goal at or under the budget, and lets a met goal finish even when over', () => {
    const under = { ...startGoal('x', undefined, 5, 200_000), tokens: 200_000 }
    expect(applyVerdict(under, { kind: 'continue', reason: 'Not yet.' }, { toolCalls: 1 }).goal.status).toBe('active')
    const over = { ...under, tokens: 300_000 }
    expect(applyVerdict(over, { kind: 'met', reason: 'Tests pass.' }, { toolCalls: 1 }).goal.status).toBe('complete')
  })

  it('adds tokens from provider usage', () => {
    expect(usageTokens({ inputTokens: 1_000, outputTokens: 200 })).toBe(1_200)
    expect(usageTokens(undefined)).toBe(0)
    expect(addGoalTokens(startGoal('x', undefined), 500).tokens).toBe(500)
  })
})

describe('a goal kept with its task', () => {
  it('reads back what was stored, and drops what is not a goal', () => {
    const stored = storableGoal({ ...startGoal('ship it', 'npm test', 5, 90_000), turns: 3, tokens: 1_234, claim: { status: 'complete', note: 'x' }, checking: true, turning: true })
    expect(stored).not.toHaveProperty('checking')
    expect(stored).not.toHaveProperty('claim')
    expect(normalizeStoredGoal(JSON.parse(JSON.stringify(stored)))).toMatchObject({ text: 'ship it', check: 'npm test', turns: 3, maxTurns: 5, budget: 90_000, tokens: 1_234 })
    expect(normalizeStoredGoal(null)).toBeUndefined()
    expect(normalizeStoredGoal({ text: 'x', status: 'running' })).toBeUndefined()
    expect(normalizeStoredGoal({ text: '', status: 'paused' })).toBeUndefined()
    expect(normalizeStoredGoal({ text: 'x', status: 'paused', check: 'a\nb' })).not.toHaveProperty('check')
  })

  it('comes back paused after a restart, with a note, and never as an active goal', () => {
    const restored = restoreGoal({ ...startGoal('ship it', 'npm test'), status: 'active' })
    expect(restored).toMatchObject({ status: 'paused', note: 'Cubex restarted. Resume the goal to continue.', check: 'npm test' })
    expect(restoreGoal({ ...startGoal('x', undefined), status: 'paused', note: 'You stopped it.' }).note).toBe('Cubex restarted. Resume the goal to continue.')
    expect(restoreGoal({ ...startGoal('x', undefined), status: 'complete' }).status).toBe('complete')
    expect(restoreGoal({ ...startGoal('x', undefined), status: 'blocked', note: 'Need a key.' })).toMatchObject({ status: 'blocked', note: 'Need a key.' })
  })
})
