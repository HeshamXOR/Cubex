import { describe, expect, it } from 'vitest'
import { createThinkTagParser } from './thinkTagParser'

describe('createThinkTagParser', () => {
  it('handles normal text without tags', () => {
    const parser = createThinkTagParser()
    const chunks = ['Hello ', 'world!', ' How are you?']
    const events = chunks.flatMap((c) => parser.push(c))
    events.push(...parser.flush())

    expect(events).toEqual([
      { type: 'text_delta', text: 'Hello ' },
      { type: 'text_delta', text: 'world!' },
      { type: 'text_delta', text: ' How are you?' }
    ])
  })

  it('handles <think>...</think> in one chunk', () => {
    const parser = createThinkTagParser()
    const events = parser.push('<think>Planning step 1.</think>Here is the answer.')
    events.push(...parser.flush())

    expect(events).toEqual([
      { type: 'reasoning_delta', text: 'Planning step 1.' },
      { type: 'text_delta', text: 'Here is the answer.' }
    ])
  })

  it('handles <think> and </think> split across 1-char chunks', () => {
    const parser = createThinkTagParser()
    const input = '<think>Deep reasoning</think>Visible answer'
    const events: ReturnType<typeof parser.push> = []
    for (const char of input) {
      events.push(...parser.push(char))
    }
    events.push(...parser.flush())

    const reasoning = events.filter((e) => e.type === 'reasoning_delta').map((e) => e.text).join('')
    const text = events.filter((e) => e.type === 'text_delta').map((e) => e.text).join('')

    expect(reasoning).toBe('Deep reasoning')
    expect(text).toBe('Visible answer')
  })

  it('handles unclosed <think> when stream ends', () => {
    const parser = createThinkTagParser()
    const events = parser.push('<think>Partial thinking that never closed')
    events.push(...parser.flush())

    // With nothing else to show, the reasoning is also the visible answer.
    expect(events).toEqual([
      { type: 'reasoning_delta', text: 'Partial thinking that never closed' },
      { type: 'text_delta', text: 'Partial thinking that never closed' }
    ])
  })

  it('handles literal < characters in normal text without tags', () => {
    const parser = createThinkTagParser()
    const chunks = ['x < 5 && y > 3\n', 'Include <stdio.h> in C program\n', '<not-a-think-tag>']
    const events = chunks.flatMap((c) => parser.push(c))
    events.push(...parser.flush())

    const fullText = events.map((e) => e.text).join('')
    expect(fullText).toBe('x < 5 && y > 3\nInclude <stdio.h> in C program\n<not-a-think-tag>')
    expect(events.every((e) => e.type === 'text_delta')).toBe(true)
  })

  it('strips single leading newline after </think> while preserving subsequent indentation', () => {
    const parser = createThinkTagParser()
    const events = [
      ...parser.push('<think>Calculate code</think>\n    const x = 1')
    ]
    events.push(...parser.flush())

    expect(events).toEqual([
      { type: 'reasoning_delta', text: 'Calculate code' },
      { type: 'text_delta', text: '    const x = 1' }
    ])
  })

  it('flushes incomplete open tag at stream end as text', () => {
    const parser = createThinkTagParser()
    const events = parser.push('<thi')
    events.push(...parser.flush())

    expect(events).toEqual([
      { type: 'text_delta', text: '<thi' }
    ])
  })

  it('gives the reasoning as text too when the stream ends inside an unclosed <think> with no answer', () => {
    const parser = createThinkTagParser()
    const events = [...parser.push('<think>The answer is '), ...parser.push('42.')]
    events.push(...parser.flush())

    expect(events.filter((event) => event.type === 'reasoning_delta').map((event) => event.text).join('')).toBe('The answer is 42.')
    expect(events.filter((event) => event.type === 'text_delta')).toEqual([{ type: 'text_delta', text: 'The answer is 42.' }])
    expect(events.at(-1)).toEqual({ type: 'text_delta', text: 'The answer is 42.' })
  })
})
