import { describe, expect, it } from 'vitest'
import { startGoal, type Goal } from '../../../shared/goal'
import { describeBudget, describeGoal, goalCheckTitle, resumeLabel } from './goalText'

const goal = (over: Partial<Goal> = {}): Goal => ({ ...startGoal('all tests pass', 'npm test', 15), ...over })

describe('describeGoal', () => {
  it('says which turn is running, and that a turn is about to start between turns', () => {
    expect(describeGoal(goal({ turns: 2 }), true)).toEqual({ headline: 'Working on it. Turn 2 of 15.' })
    expect(describeGoal(goal({ turns: 2, turning: true }), false)).toEqual({ headline: 'Working on it. Turn 2 of 15.' })
    expect(describeGoal(goal({ turns: 3 }), false)).toEqual({ headline: 'Starting turn 3 of 15.' })
  })

  it('shows why the last check did not end the goal, while it goes on', () => {
    expect(describeGoal(goal({ turns: 3, note: 'The check failed with exit code 1: npm test' }), true).detail).toBe('The check failed with exit code 1: npm test')
  })

  it('says it is checking, and what it runs', () => {
    expect(describeGoal(goal({ checking: true }), false)).toEqual({ headline: 'Checking whether the goal is met.', detail: 'Running npm test' })
    expect(describeGoal(goal({ checking: true, check: undefined }), false)).toEqual({ headline: 'Checking whether the goal is met.' })
  })

  it('names every way a goal stops, with the reason', () => {
    expect(describeGoal(goal({ status: 'paused', note: 'You stopped the turn.' }), false))
      .toEqual({ headline: 'Paused.', detail: 'You stopped the turn.' })
    expect(describeGoal(goal({ status: 'complete', turns: 3, note: 'The check passed: npm test' }), false))
      .toEqual({ headline: 'Done after 3 turns.', detail: 'The check passed: npm test' })
    expect(describeGoal(goal({ status: 'complete', turns: 1 }), false)).toEqual({ headline: 'Done after 1 turn.' })
    expect(describeGoal(goal({ status: 'blocked', note: 'Needs the staging API key.' }), false))
      .toEqual({ headline: 'The agent needs something from you.', detail: 'Needs the staging API key.' })
    expect(describeGoal(goal({ status: 'stalled' }), false).headline).toBe('The agent stopped without finishing.')
    expect(describeGoal(goal({ status: 'limit', note: 'Stopped after 15 turns.' }), false))
      .toEqual({ headline: 'The goal reached a limit.', detail: 'Stopped after 15 turns.' })
  })
})

describe('resumeLabel', () => {
  it('offers a way back in only for a goal that has stopped, in words that fit why it stopped', () => {
    expect(resumeLabel(goal({ status: 'paused' }))).toBe('Resume')
    expect(resumeLabel(goal({ status: 'blocked' }))).toBe('Continue')
    expect(resumeLabel(goal({ status: 'stalled' }))).toBe('Try again')
    expect(resumeLabel(goal({ status: 'limit' }))).toBe('Keep going')
    expect(resumeLabel(goal({ status: 'active' }))).toBeUndefined()
    expect(resumeLabel(goal({ status: 'complete' }))).toBeUndefined()
  })
})

describe('goalCheckTitle', () => {
  it('names the turn', () => {
    expect(goalCheckTitle(3, 15)).toBe('Goal check, turn 3 of 15')
  })
})

describe('describeBudget', () => {
  it('says what was used of the budget, and nothing without one', () => {
    expect(describeBudget(goal({ budget: 200_000, tokens: 38_000 }))).toBe('38k of 200k tokens')
    expect(describeBudget(goal({ budget: 200_000 }))).toBe('0 of 200k tokens')
    expect(describeBudget(goal())).toBeUndefined()
  })
})
