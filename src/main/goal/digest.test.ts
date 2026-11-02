import { describe, expect, it } from 'vitest'
import type { AIMessage } from '@core/types'
import { digestTurn } from './digest'

const assistant = (...content: AIMessage['content']): AIMessage => ({ role: 'assistant', content })
const tool = (...content: AIMessage['content']): AIMessage => ({ role: 'tool', content })

describe('digestTurn', () => {
  it('lists each call with what it returned, and what the agent said', () => {
    const text = digestTurn([
      assistant({ type: 'text', text: 'Running the tests.' }, { type: 'tool_use', id: 'a', name: 'run_command', input: { command: 'npm test' } }),
      tool({ type: 'tool_result', toolUseId: 'a', content: [{ type: 'text', text: 'Tests  12 passed (12)\nDuration 3s' }] }),
      assistant({ type: 'text', text: 'All 12 tests pass.' })
    ])
    expect(text).toBe([
      'The agent said: Running the tests.',
      '- run_command {"command":"npm test"}',
      '  returned (run_command): Tests 12 passed (12) Duration 3s',
      'The agent said: All 12 tests pass.'
    ].join('\n'))
  })

  it('shortens long inputs and results, and shows an image result as such', () => {
    const text = digestTurn([
      assistant({ type: 'tool_use', id: 'c', name: 'write_file', input: { path: 'big.ts', content: 'x'.repeat(5000) } }),
      tool({ type: 'tool_result', toolUseId: 'c', content: [{ type: 'image', source: { kind: 'url', url: 'https://x/y.png' } }, { type: 'text', text: 'y'.repeat(5000) }] })
    ])
    expect(text.length).toBeLessThan(1_300)
    expect(text).toContain('...')
    expect(text).toContain('[image]')
  })
})
