import { describe, expect, it } from 'vitest'
import { latestReasoningStep } from './reasoningStep'

describe('latestReasoningStep', () => {
  it('is empty for empty or blank reasoning', () => {
    expect(latestReasoningStep('')).toBe('')
    expect(latestReasoningStep('\n  \n')).toBe('')
  })

  it('takes the last sentence of the last non-empty line', () => {
    expect(latestReasoningStep('Read the config.\nCheck the retry path. Then write the test.\n\n')).toBe('Then write the test.')
  })

  it('removes markdown markers', () => {
    expect(latestReasoningStep('## Plan')).toBe('Plan')
    expect(latestReasoningStep('- **Check** `effort.ts`')).toBe('Check effort.ts')
    expect(latestReasoningStep('2. Run the suite')).toBe('Run the suite')
    expect(latestReasoningStep('> quoted thought')).toBe('quoted thought')
  })

  it('never shows a spaced em dash or a middle dot', () => {
    expect(latestReasoningStep('Parse first — then stream')).toBe('Parse first - then stream')
    expect(latestReasoningStep('a·b')).toBe('a b')
  })

  it('skips a line that is only markers', () => {
    expect(latestReasoningStep('Look at the parser.\n---')).toBe('Look at the parser.')
  })

  it('cuts long steps to 90 characters with an ellipsis', () => {
    const step = latestReasoningStep('word '.repeat(40))
    expect(step.length).toBeLessThanOrEqual(90)
    expect(step.endsWith('...')).toBe(true)
  })

  it('finds the newest step at the end of very long reasoning', () => {
    expect(latestReasoningStep(`${'Earlier thinking. '.repeat(5000)}\nFinal check.`)).toBe('Final check.')
  })
})
