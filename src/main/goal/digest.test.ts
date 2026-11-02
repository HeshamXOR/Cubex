import { describe, expect, it } from 'vitest'
import type { AIMessage } from '@core/types'
import { DIGEST_CHARS, digestTurn } from './digest'

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

  it('marks a failed call as failed', () => {
    const text = digestTurn([
      assistant({ type: 'tool_use', id: 'b', name: 'edit_file', input: { path: 'a.ts' } }),
      tool({ type: 'tool_result', toolUseId: 'b', isError: true, content: [{ type: 'text', text: 'old_string not found' }] })
    ])
    expect(text).toContain('failed (edit_file): old_string not found')
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

  it('keeps the newest part when the record is long', () => {
    const messages: AIMessage[] = []
    for (let i = 0; i < 400; i++) {
      messages.push(assistant({ type: 'tool_use', id: `t${i}`, name: 'read_file', input: { path: `src/file-${i}.ts` } }))
      messages.push(tool({ type: 'tool_result', toolUseId: `t${i}`, content: [{ type: 'text', text: `contents of file ${i}` }] }))
    }
    const text = digestTurn(messages)
    expect(text.length).toBeLessThanOrEqual(DIGEST_CHARS + 4)
    expect(text.startsWith('...')).toBe(true)
    expect(text).toContain('file-399.ts')
    expect(text).not.toContain('file-0.ts')
  })

  it('says so when nothing was recorded', () => {
    expect(digestTurn([])).toBe('(nothing was recorded for this turn)')
    expect(digestTurn([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])).toBe('(nothing was recorded for this turn)')
  })

  it('names a result whose call is not in the record as a tool', () => {
    expect(digestTurn([tool({ type: 'tool_result', toolUseId: 'orphan', content: [{ type: 'text', text: 'ok' }] })])).toBe('  returned (tool): ok')
  })
})
