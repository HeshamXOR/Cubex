import { describe, expect, it } from 'vitest'
import type { CommandOutputArtifact, CommandOutputPage } from '../../../shared/ipc'
import { MAX_RAW_CHARS, TAIL_WINDOW_BYTES, advanceTail, type ReadPage } from './taskTail'

/**
 * A saved output with the main process's own paging rules (byte offsets, never ending a page inside a
 * character, refusing an offset that lands inside one), growing as the test appends to it.
 */
function savedOutput(initial = '', limits = { max: 64 * 1024 }) {
  let bytes = Buffer.from(initial, 'utf8')
  const reads: Array<[number, number]> = []
  const artifact = (): CommandOutputArtifact => ({
    id: 'out', conversationId: 'c', command: 'npm run dev', createdAt: 1, status: 'running', capturedBytes: bytes.length, totalBytes: bytes.length, truncated: false
  })
  const read: ReadPage = async (offset, limit): Promise<CommandOutputPage> => {
    reads.push([offset, limit])
    if (!Number.isInteger(offset) || offset < 0 || limit < 4 || limit > limits.max) throw new Error('Output offset must be a non-negative byte offset; limit must be 4–65536 bytes.')
    if (offset > bytes.length) throw new Error('Output offset is beyond the saved output.')
    if (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) throw new Error('Output offset splits a UTF-8 character. Use the previous page’s nextOffset.')
    let end = Math.min(offset + limit, bytes.length)
    while (end > offset && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
    return { artifact: artifact(), text: bytes.subarray(offset, end).toString('utf8'), offset, ...(end < bytes.length ? { nextOffset: end } : {}), eof: end === bytes.length }
  }
  return { read, reads, append: (text: string) => { bytes = Buffer.concat([bytes, Buffer.from(text, 'utf8')]) }, size: () => bytes.length }
}

describe('following a task\'s saved output', () => {
  it('reads a short output whole and remembers where it ended', async () => {
    const out = savedOutput('listening on port 4010\n')
    const cursor = await advanceTail(out.read, undefined)
    expect(cursor.raw).toBe('listening on port 4010\n')
    expect(cursor.complete).toBe(true)
    expect(cursor.offset).toBe(out.size())
    expect(out.reads).toEqual([[0, TAIL_WINDOW_BYTES]])
  })

  it('reads only what was written since the last look', async () => {
    const out = savedOutput('one\n')
    const first = await advanceTail(out.read, undefined)
    out.append('two\nthree\n')
    const second = await advanceTail(out.read, first)
    expect(second.raw).toBe('one\ntwo\nthree\n')
    expect(second.complete).toBe(true)
    expect(out.reads.at(-1)).toEqual([first.offset, 64 * 1024])
    // Nothing new: the cursor stays where it is.
    const third = await advanceTail(out.read, second)
    expect(third.raw).toBe(second.raw)
    expect(third.offset).toBe(second.offset)
  })

  it('opens a long output at its newest window instead of reading it all', async () => {
    const lines = Array.from({ length: 4_000 }, (_, index) => `GET /api/uploads/${index} 200 in ${index % 40}ms`)
    const out = savedOutput(lines.join('\n') + '\n')
    const cursor = await advanceTail(out.read, undefined)
    expect(cursor.complete).toBe(false)
    expect(cursor.raw.endsWith('GET /api/uploads/3999 200 in 39ms\n')).toBe(true)
    expect(Buffer.byteLength(cursor.raw)).toBeLessThanOrEqual(TAIL_WINDOW_BYTES + 4)
    expect(cursor.offset).toBe(out.size())
    expect(out.reads.length).toBeLessThanOrEqual(3)
  })

  it('never lands inside a multi-byte character when it jumps to the end', async () => {
    // Three bytes per character, so most window starts fall inside one.
    for (const pad of ['', 'a', 'ab']) {
      const out = savedOutput(pad + '漢字'.repeat(20_000) + '\n')
      const cursor = await advanceTail(out.read, undefined)
      expect(cursor.raw).not.toContain('�')
      expect(cursor.raw.endsWith('漢字\n')).toBe(true)
      expect(cursor.offset).toBe(out.size())
    }
  })

  it('catches up across several pages and jumps to the newest output when it is far behind', async () => {
    const out = savedOutput('start\n')
    const first = await advanceTail(out.read, undefined)
    out.append('x'.repeat(100) + '\n')
    const close = await advanceTail(out.read, first)
    expect(close.complete).toBe(true)

    // Far more than three pages arrived: older lines are skipped, and the view says so.
    out.append(('y'.repeat(99) + '\n').repeat(3_000))
    out.append('the very last line\n')
    const far = await advanceTail(out.read, close)
    expect(far.complete).toBe(false)
    expect(far.raw.endsWith('the very last line\n')).toBe(true)
    expect(far.raw).not.toContain('start')
    expect(far.offset).toBe(out.size())
  })

  it('keeps a bounded amount and begins at a whole line', async () => {
    const out = savedOutput('')
    let cursor = await advanceTail(out.read, undefined)
    for (let round = 0; round < 8; round++) {
      out.append(`${'z'.repeat(39)}\n`.repeat(1_000))
      cursor = await advanceTail(out.read, cursor)
    }
    expect(cursor.raw.length).toBeLessThanOrEqual(MAX_RAW_CHARS)
    expect(cursor.complete).toBe(false)
    expect(cursor.raw.startsWith('z'.repeat(39) + '\n')).toBe(true)
    expect(cursor.offset).toBe(out.size())
  })

  it('passes a real failure on instead of hiding it', async () => {
    const failing: ReadPage = async () => { throw new Error('Saved command output is unavailable. Older outputs may have expired.') }
    await expect(advanceTail(failing, undefined)).rejects.toThrow('unavailable')
  })
})
