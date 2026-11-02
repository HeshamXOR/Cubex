import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AIMessage } from '@core/types'
import { TurnLogStore, recordableTurn } from './turnLog'

const callThenResult = (id: string, name: string, input: Record<string, unknown>, result: string, isError = false): AIMessage[] => [
  { role: 'assistant', content: [{ type: 'tool_use', id, name, input: input as never }] },
  { role: 'tool', content: [{ type: 'tool_result', toolUseId: id, content: [{ type: 'text', text: result }], ...(isError ? { isError: true } : {}) }] }
]

const closingText = (text: string): AIMessage => ({ role: 'assistant', content: [{ type: 'text', text }] })

describe('what is kept of a turn', () => {

  it('keeps the calls, their results and the closing answer in order', () => {
    const kept = recordableTurn([...callThenResult('t1', 'read_file', { path: 'a.txt' }, 'first file'), closingText('Done.')])!
    expect(kept.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant'])
    expect(kept[0]!.content).toEqual([{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.txt' } }])
    expect(kept[1]!.content).toEqual([{ type: 'tool_result', toolUseId: 't1', content: [{ type: 'text', text: 'first file' }] }])
    expect(kept[2]!.content).toEqual([{ type: 'text', text: 'Done.' }])
  })

  it('answers a call the turn never finished, so no history holds a call without a result', () => {
    const kept = recordableTurn([
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'a', name: 'read_file', input: { path: 'a' } },
        { type: 'tool_use', id: 'b', name: 'read_file', input: { path: 'b' } }
      ] },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'a', content: [{ type: 'text', text: 'A' }] }] }
    ])!
    expect(kept.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant'])
    const results = kept[1]!.content.flatMap((p) => (p.type === 'tool_result' ? [[p.toolUseId, p.isError ?? false]] : []))
    expect(results).toEqual([['a', false], ['b', true]])
    expect(JSON.stringify(kept[2])).toMatch(/stopped before the assistant finished/)
  })
})

describe('the record kept on disk', () => {
  const withStore = (run: (store: TurnLogStore, dir: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), 'cubex-turnlog-'))
    try { run(new TurnLogStore(dir), dir) } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
  }
  const turn = (name: string): AIMessage[] => [...callThenResult(`id-${name}`, 'read_file', { path: name }, `contents of ${name}`), closingText(`Read ${name}.`)]

  it('is read back by the id of the message each turn answered, and survives a new process', () => {
    withStore((store, dir) => {
      store.save('task-1', 'm1', turn('a.txt'))
      store.save('task-1', 'm2', turn('b.txt'))
      expect([...store.load('task-1').keys()]).toEqual(['m1', 'm2'])
      const again = new TurnLogStore(dir)
      expect(JSON.stringify(again.load('task-1').get('m2'))).toMatch(/contents of b\.txt/)
      expect(again.load('another-task').size).toBe(0)
    })
  })

  it('does not write a record for a turn without tools, or for an unsafe task id', () => {
    withStore((store, dir) => {
      store.save('task-1', 'm1', [closingText('Plain.')])
      store.save('../escape', 'm1', turn('a.txt'))
      store.save('task-1', '', turn('a.txt'))
      expect(store.load('task-1').size).toBe(0)
      expect(new TurnLogStore(dir).load('../escape').size).toBe(0)
    })
  })
})
