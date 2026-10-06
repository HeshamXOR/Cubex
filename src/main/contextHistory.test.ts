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

  it.each([undefined, '', 'removed-user', 'a2', 'u1'])('falls back to full history for missing, stale or non-user boundary %s', (id) => {
    expect(selectContextMessages(messages, id)).toBe(messages)
  })

  it('handles a cleared conversation and keeps later turns after the boundary', () => {
    expect(selectContextMessages([], 'u2')).toEqual([])
    const extended = [...messages, { id: 'u3', role: 'user', text: 'Next turn' }]
    expect(selectContextMessages(extended, 'u2').map((message) => message.id)).toEqual(['u2', 'a2', 'u3'])
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

  it.each([undefined, '', 'removed-user', 'a2', 'u1'])('sends the full history and no summary for missing, stale or non-user boundary %s', (id) => {
    const selected = selectContext(messages, id, 'Goal: ship the parser.')
    expect(selected.messages).toBe(messages)
    expect(selected.summary).toBeUndefined()
  })

  it.each([undefined, '', '   \n'])('does not inject a blank summary (%j)', (summary) => {
    const selected = selectContext(messages, 'u2', summary)
    expect(selected.messages).toEqual(messages.slice(2))
    expect(selected.summary).toBeUndefined()
  })

  it('keeps later turns after the boundary', () => {
    const extended = [...messages, { id: 'u3', role: 'user', text: 'Next turn' }]
    expect(selectContext(extended, 'u2', 'S').messages.map((message) => message.id)).toEqual(['u2', 'a2', 'u3'])
  })
})

describe('summary message', () => {
  it('wraps the summary in conversation_summary tags after a one-line preface', () => {
    const text = formatSummaryMessage('Goal: ship the parser.\n- Chose a hand-written lexer.')
    const [preface, ...rest] = text.split('\n')
    expect(preface).toMatch(/compacted into the summary below/)
    expect(preface).not.toMatch(/<conversation_summary>/)
    expect(rest.join('\n')).toBe('<conversation_summary>\nGoal: ship the parser.\n- Chose a hand-written lexer.\n</conversation_summary>')
  })

  it('is recognized by its text, and ordinary messages are not', () => {
    expect(isSummaryMessageText(formatSummaryMessage('Goal: x'))).toBe(true)
    expect(isSummaryMessageText('Please summarize <conversation_summary> for me')).toBe(false)
    expect(isSummaryMessageText('Inspect this task')).toBe(false)
  })
})
