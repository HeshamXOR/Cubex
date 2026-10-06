import { describe, expect, it } from 'vitest'
import { geminiEffortChoices, geminiThinkingConfig, geminiThinkingProfile } from './thinking'

const values = (id: string): Array<string | undefined> => geminiEffortChoices(id).map((choice) => choice.value)

describe('geminiThinkingProfile', () => {
  it.each([
    ['gemini-3-pro-preview', ['low', 'high']],
    ['gemini-3.1-pro-preview', ['low', 'medium', 'high']],
    ['gemini-3-flash-preview', ['minimal', 'low', 'medium', 'high']],
    ['gemini-3.5-flash', ['minimal', 'low', 'medium', 'high']],
    ['gemini-3.6-flash', ['minimal', 'low', 'medium', 'high']],
    // minimal is an API error on these two
    ['gemini-3.7-flash', ['low', 'medium', 'high']],
    ['gemini-3.8-flash', ['low', 'medium', 'high']],
    ['gemini-3.1-flash-lite', ['minimal', 'low', 'medium', 'high']],
    ['gemini-3.5-flash-lite', ['minimal', 'low', 'medium', 'high']],
    // a generation we do not know yet: only the levels every Gemini 3 model accepts
    ['gemini-4-flash', ['low', 'high']],
    ['gemini-3.9-flash', ['low', 'high']]
  ])('uses thinkingLevel for %s and offers only valid levels', (id, expected) => {
    expect(geminiThinkingProfile(id)?.control).toBe('level')
    expect(values(id)).toEqual(expected)
  })

  it.each([
    ['gemini-2.5-pro', [128, 1024, 8192, 24576, 32768]],
    ['gemini-2.5-flash', [0, 1024, 8192, 24576]],
    ['gemini-2.5-flash-preview-09-2025', [0, 1024, 8192, 24576]],
    ['gemini-2.5-flash-lite', [1024, -1, 24576]],
    ['gemini-2.5-flash-lite-preview-09-2025', [1024, -1, 24576]]
  ])('uses thinkingBudget for %s with budgets inside its documented range', (id, budgets) => {
    const profile = geminiThinkingProfile(id)
    expect(profile?.control).toBe('budget')
    expect(profile?.choices.map((choice) => choice.budget)).toEqual(budgets)
  })

  it('labels the zero budget as off only where thinking can be switched off', () => {
    expect(geminiEffortChoices('gemini-2.5-flash')[0]).toMatchObject({ value: 'minimal', label: 'Off' })
    // 2.5 Pro cannot disable thinking; its smallest budget is 128
    expect(geminiEffortChoices('gemini-2.5-pro')[0]).toMatchObject({ value: 'minimal', label: 'Minimum' })
    expect(geminiEffortChoices('gemini-2.5-flash-lite').find((choice) => choice.budget === -1)?.label).toBe('Dynamic')
  })

  it.each(['gemini-flash-latest', 'gemini-pro-latest', 'gemini-flash-lite-latest'])(
    'knows %s thinks but not how its depth is expressed, so it offers no control',
    (id) => {
      const profile = geminiThinkingProfile(id)
      expect(profile).toBeDefined()
      expect(profile?.control).toBeUndefined()
      expect(profile?.choices).toEqual([])
    }
  )

  it.each([
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-pro',
    'gemma-3-27b-it',
    'gemini-2.5-flash-image',
    'gemini-3-pro-image-preview',
    'gemini-2.5-flash-preview-tts',
    'gemini-live-2.5-flash-preview',
    'gemini-2.5-flash-native-audio-preview-09-2025',
    'text-embedding-004'
  ])('sends no thinking config to %s (the API rejects it for non-thinking models)', (id) => {
    expect(geminiThinkingProfile(id)).toBeUndefined()
    expect(geminiThinkingConfig(id, 'high')).toBeUndefined()
  })

  it('lets explicit model metadata override the id', () => {
    expect(geminiThinkingProfile('gemini-2.5-pro', false)).toBeUndefined()
    expect(geminiThinkingProfile('some-tuned-model', true)).toEqual({ choices: [] })
    expect(geminiThinkingProfile('some-tuned-model')).toBeUndefined()
  })

  it('ignores a models/ prefix and letter case', () => {
    expect(geminiThinkingProfile('models/Gemini-2.5-Flash')?.control).toBe('budget')
  })
})

describe('geminiThinkingConfig', () => {
  it('always asks for thought summaries on a thinking model', () => {
    expect(geminiThinkingConfig('gemini-3-flash-preview', undefined)).toEqual({ includeThoughts: true })
    expect(geminiThinkingConfig('gemini-2.5-pro', undefined)).toEqual({ includeThoughts: true })
    expect(geminiThinkingConfig('gemini-flash-latest', 'high')).toEqual({ includeThoughts: true })
  })

  it('sends thinkingLevel (never a budget) to Gemini 3', () => {
    expect(geminiThinkingConfig('gemini-3-flash-preview', 'minimal')).toEqual({ includeThoughts: true, thinkingLevel: 'minimal' })
    expect(geminiThinkingConfig('gemini-3.1-pro-preview', 'medium')).toEqual({ includeThoughts: true, thinkingLevel: 'medium' })
  })

  it('sends thinkingBudget (never a level) to Gemini 2.5', () => {
    expect(geminiThinkingConfig('gemini-2.5-flash', 'minimal')).toEqual({ includeThoughts: true, thinkingBudget: 0 })
    expect(geminiThinkingConfig('gemini-2.5-flash', 'medium')).toEqual({ includeThoughts: true, thinkingBudget: 8192 })
    expect(geminiThinkingConfig('gemini-2.5-pro', 'minimal')).toEqual({ includeThoughts: true, thinkingBudget: 128 })
    expect(geminiThinkingConfig('gemini-2.5-flash-lite', 'medium')).toEqual({ includeThoughts: true, thinkingBudget: -1 })
  })

  it('maps an effort the model does not offer to the nearest one it does', () => {
    // 3 Pro has low and high only; a tie goes up so reasoning is never silently cut
    expect(geminiThinkingConfig('gemini-3-pro-preview', 'medium')).toMatchObject({ thinkingLevel: 'high' })
    expect(geminiThinkingConfig('gemini-3-pro-preview', 'minimal')).toMatchObject({ thinkingLevel: 'low' })
    expect(geminiThinkingConfig('gemini-3.1-pro-preview', 'xhigh')).toMatchObject({ thinkingLevel: 'high' })
    expect(geminiThinkingConfig('gemini-2.5-pro', 'max')).toMatchObject({ thinkingBudget: 32768 })
    expect(geminiThinkingConfig('gemini-2.5-flash', 'max')).toMatchObject({ thinkingBudget: 24576 })
  })
})
