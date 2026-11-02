import { describe, expect, it } from 'vitest'
import type { DelegateActivity } from '../../../shared/peers'
import { previewLines, STEP_SPOKEN, stepView } from './delegateText'

const activity = (over: Partial<DelegateActivity> = {}): DelegateActivity => ({ name: 'Codex', role: 'implement', status: 'working', steps: [], files: [], ...over })

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
