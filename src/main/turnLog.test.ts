import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  it('keeps nothing for a turn that used no tool: the stored answer already says it all', () => {
    expect(recordableTurn([closingText('Just an answer.')])).toBeUndefined()
    expect(recordableTurn([])).toBeUndefined()
  })

  it('keeps the calls, their results and the closing answer in order', () => {
    const kept = recordableTurn([...callThenResult('t1', 'read_file', { path: 'a.txt' }, 'first file'), closingText('Done.')])!
    expect(kept.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant'])
    expect(kept[0]!.content).toEqual([{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a.txt' } }])
    expect(kept[1]!.content).toEqual([{ type: 'tool_result', toolUseId: 't1', content: [{ type: 'text', text: 'first file' }] }])
    expect(kept[2]!.content).toEqual([{ type: 'text', text: 'Done.' }])
  })

  it('drops reasoning, which belongs to the request that produced it, and the markup of recovered text calls', () => {
    const kept = recordableTurn([
      { role: 'assistant', content: [
        { type: 'reasoning', text: 'secret plan', signature: 'sig' },
        { type: 'text', text: 'Reading.<invoke name="fs_read"><parameter name="path">a.txt</parameter></invoke>' },
        { type: 'tool_use', id: 'xmlcall_1', name: 'read_file', input: { path: 'a.txt' } }
      ] },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'xmlcall_1', content: [{ type: 'text', text: 'ok' }] }] }
    ])!
    expect(JSON.stringify(kept)).not.toMatch(/secret plan|invoke|fs_read/)
    expect(kept[0]!.content.map((p) => p.type)).toEqual(['text', 'tool_use'])
  })

  it('shortens long output and long arguments, naming how much was left out', () => {
    const big = 'x'.repeat(50_000)
    const kept = recordableTurn(callThenResult('t1', 'write_file', { path: 'big.html', content: big }, big))!
    const call = kept[0]!.content[0]
    const result = kept[1]!.content[0]
    const content = call && call.type === 'tool_use' ? (call.input as { content: string }).content : ''
    const text = result && result.type === 'tool_result' && result.content[0]?.type === 'text' ? result.content[0].text : ''
    expect(content.length).toBeLessThan(2_200)
    expect(content).toMatch(/48,000 characters not kept/)
    expect(text.length).toBeLessThan(6_200)
    expect(text).toMatch(/44,000 characters not kept/)
  })

  it('keeps the whole outline of a long turn by shrinking each step further instead of dropping it', () => {
    const steps = Array.from({ length: 60 }, (_, i) => callThenResult(`t${i}`, 'read_file', { path: `f${i}.ts` }, 'y'.repeat(8_000))).flat()
    const kept = recordableTurn([...steps, closingText('All read.')])!
    expect(kept.filter((m) => m.role === 'assistant' && m.content.some((p) => p.type === 'tool_use'))).toHaveLength(60)
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(96_000)
    expect(JSON.stringify(kept.at(-1))).toMatch(/All read\./)
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

  it('answers a call that was the last thing said, and drops a result with no call before it', () => {
    const kept = recordableTurn([
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'orphan', content: [{ type: 'text', text: 'no call' }] }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'only', name: 'run_command', input: { command: 'ls' } }] }
    ])!
    expect(JSON.stringify(kept)).not.toMatch(/orphan/)
    expect(kept.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant'])
  })

  it('replaces an image in a result with a note, and keeps the error mark', () => {
    const kept = recordableTurn([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'img', name: 'read_file', input: { path: 'p.png' } }] },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'img', isError: true, content: [
        { type: 'text', text: 'broken' }, { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'AAAA' } }
      ] }] },
      closingText('Could not read it.')
    ])!
    const result = kept[1]!.content[0]
    expect(result).toMatchObject({ type: 'tool_result', isError: true })
    expect(JSON.stringify(result)).toMatch(/broken[\s\S]*1 image not kept/)
    expect(JSON.stringify(result)).not.toMatch(/AAAA/)
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

  it('replaces the record of a message that was answered again', () => {
    withStore((store) => {
      store.save('task-1', 'm1', turn('old.txt'))
      store.save('task-1', 'm1', turn('new.txt'))
      expect(store.load('task-1').size).toBe(1)
      expect(JSON.stringify(store.load('task-1').get('m1'))).toMatch(/new\.txt/)
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

  it('forgets a task when it is deleted, and reads a damaged file as empty', () => {
    withStore((store, dir) => {
      store.save('task-1', 'm1', turn('a.txt'))
      store.deleteConversation('task-1')
      expect(new TurnLogStore(dir).load('task-1').size).toBe(0)
      const errors: unknown[] = []
      const damaged = new TurnLogStore(dir, { onError: (error) => errors.push(error) })
      writeFileSync(join(dir, 'task-2.json'), '{ not json')
      expect(damaged.load('task-2').size).toBe(0)
      expect(errors).toHaveLength(1)
    })
  })

  it('keeps the newest turns when a task has more than it holds', () => {
    withStore((store) => {
      for (let i = 0; i < 205; i++) store.save('task-1', `m${i}`, turn(`f${i}.txt`))
      const ids = [...store.load('task-1').keys()]
      expect(ids).toHaveLength(200)
      expect(ids[0]).toBe('m5')
      expect(ids.at(-1)).toBe('m204')
    })
  })
})
