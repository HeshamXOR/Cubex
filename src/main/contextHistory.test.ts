import { describe, expect, it } from 'vitest'
import { formatSummaryMessage, isSummaryMessageText, selectContext, selectContextMessages } from './contextHistory'

const messages = [
  { id: 'u1', role: 'user', text: 'Original request' },
  { id: 'a1', role: 'assistant', text: 'Original reply' },
  { id: 'u2', role: 'user', text: 'Retained request' },
  { id: 'a2', role: 'assistant', text: 'Retained reply' }
]

describe('non-destructive context boundaries', () => {
  it('retains complete turns from the selected user message without modifying history', () => {
    const source = structuredClone(messages)
    expect(selectContextMessages(source, 'u2')).toEqual(messages.slice(2))
    expect(source).toEqual(messages)
  })
})

describe('summary-aware context selection', () => {
  it('returns the summary together with the messages after the boundary', () => {
    const source = structuredClone(messages)
    const selected = selectContext(source, 'u2', '  Goal: ship the parser.  ')
    expect(selected.messages).toEqual(messages.slice(2))
    expect(selected.summary).toBe('Goal: ship the parser.')
    expect(source).toEqual(messages)
  })

  it('keeps later turns after the boundary', () => {
    const extended = [...messages, { id: 'u3', role: 'user', text: 'Next turn' }]
    expect(selectContext(extended, 'u2', 'S').messages.map((message) => message.id)).toEqual(['u2', 'a2', 'u3'])
  })
})

describe('summary message', () => {

  it('is recognized by its text, and ordinary messages are not', () => {
    expect(isSummaryMessageText(formatSummaryMessage('Goal: x'))).toBe(true)
    expect(isSummaryMessageText('Please summarize <conversation_summary> for me')).toBe(false)
    expect(isSummaryMessageText('Inspect this task')).toBe(false)
  })
})
