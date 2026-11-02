import { createHash } from 'node:crypto'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COMMAND_OUTPUT_MAX_BYTES, CommandOutputStore } from './commandOutput'

describe('durable command output', () => {
  let directory: string
  let root: string
  let store: CommandOutputStore
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cubex-output-test-'))
    root = join(directory, 'output')
    store = new CommandOutputStore(root)
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))

  function save(text: string, conversationId = 'task') {
    const writer = store.create(conversationId, { command: 'test command' })
    writer.append(text)
    return writer.finish({ status: 'completed', exitCode: 0 })
  }

  it('persists exact combined text, typed metadata and a generated reveal path across restart', () => {
    const artifact = save('first\nمرحبا\nlast\n')
    const path = store.revealPath('task', artifact.id)
    expect(path).toBe(join(realpathSync.native(root), createHash('sha256').update('task').digest('hex').slice(0, 32), `${artifact.id}.log`))
    expect(readFileSync(path, 'utf8')).toBe('first\nمرحبا\nlast\n')
    const restarted = new CommandOutputStore(root)
    expect(restarted.get('task', artifact.id)).toEqual(artifact)
    expect(restarted.read('task', artifact.id)).toMatchObject({ text: 'first\nمرحبا\nlast\n', offset: 0, eof: true })
    expect(readdirSync(dirname(path)).some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('paginates by byte offsets without splitting UTF-8 or losing a giant single line', () => {
    const text = 'A🙂مرحبا编码'.repeat(100)
    const artifact = save(text)
    let offset = 0
    let reconstructed = ''
    do {
      const page = store.read('task', artifact.id, { offset, limit: 7 })!
      expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(7)
      expect(page.text).not.toContain('�')
      reconstructed += page.text
      if (page.eof) break
      expect(page.nextOffset).toBeGreaterThan(offset)
      offset = page.nextOffset!
    } while (true)
    expect(reconstructed).toBe(text)
    expect(() => store.read('task', artifact.id, { offset: 2 })).toThrow('splits a UTF-8 character')
  })

  it('captures only a bounded contiguous prefix and reports discarded output honestly', () => {
    const writer = store.create('task', { command: 'verbose' })
    const prefix = 'a'.repeat(COMMAND_OUTPUT_MAX_BYTES - 1)
    writer.append(prefix)
    writer.append('🙂lost')
    writer.append('tail')
    const artifact = writer.finish({ status: 'failed', exitCode: 9 })
    expect(artifact).toMatchObject({ capturedBytes: prefix.length, totalBytes: prefix.length + 12, truncated: true, status: 'failed', exitCode: 9 })
    expect(statSync(store.revealPath('task', writer.id)).size).toBeLessThanOrEqual(COMMAND_OUTPUT_MAX_BYTES)
    const last = store.read('task', writer.id, { offset: prefix.length - 4 })!
    expect(last.text).toBe('aaaa')
    expect(last.eof).toBe(true)
    expect(last.artifact.truncated).toBe(true)
  })

  it('recovers an unfinished receipt without claiming an exit code or original output size', () => {
    const artifact = save('survived restart')
    const path = store.revealPath('task', artifact.id).replace(/\.log$/, '.json')
    writeFileSync(path, JSON.stringify({ ...artifact, status: 'running', completedAt: undefined, exitCode: undefined, capturedBytes: 0, totalBytes: 0 }))
    const restarted = new CommandOutputStore(root)
    const recovered = restarted.get('task', artifact.id)!
    expect(recovered).toMatchObject({ status: 'interrupted', capturedBytes: 16, truncated: false })
    expect(recovered.totalBytes).toBeUndefined()
    expect(recovered.exitCode).toBeUndefined()
    expect(restarted.read('task', artifact.id)?.text).toBe('survived restart')
    expect(new CommandOutputStore(root).get('task', artifact.id)).toEqual(recovered)
  })

  it('keeps task IDs out of paths and rejects foreign IDs, paths and forged ownership', () => {
    const artifact = save('secret task output', '../imported/task')
    expect(store.get('another task', artifact.id)).toBeNull()
    expect(store.read('another task', artifact.id)).toBeNull()
    expect(() => store.revealPath('another task', artifact.id)).toThrow('No matching')
    expect(() => store.read('../imported/task', '../../secret.txt')).toThrow('Invalid command output id')
    const path = store.revealPath('../imported/task', artifact.id).replace(/\.log$/, '.json')
    writeFileSync(path, JSON.stringify({ ...artifact, conversationId: 'another task' }))
    expect(() => store.read('../imported/task', artifact.id)).toThrow('Invalid saved command output metadata')
  })

  it('rejects task-directory junctions and output hardlinks instead of reading their targets', () => {
    const artifact = save('owned')
    const path = store.revealPath('task', artifact.id)
    const outside = join(directory, 'outside.log')
    writeFileSync(outside, 'not owned')
    unlinkSync(path)
    linkSync(outside, path)
    expect(() => store.read('task', artifact.id)).toThrow('Unsafe or oversized')
    expect(() => store.revealPath('task', artifact.id)).toThrow('Unsafe or oversized')
    unlinkSync(path)
    const target = join(directory, 'other-directory')
    mkdirSync(target)
    const key = createHash('sha256').update('linked-task').digest('hex').slice(0, 32)
    const link = join(root, key)
    symlinkSync(target, link, 'junction')
    try {
      expect(() => store.create('linked-task', { command: 'echo nope' })).toThrow('cannot be a link')
      expect(() => store.list('linked-task')).toThrow('cannot be a link')
    } finally { unlinkSync(link) }
  })

  it('rejects oversized/tampered receipts and output rather than loading unbounded data', () => {
    const artifact = save('owned')
    const path = store.revealPath('task', artifact.id)
    writeFileSync(path, 'x'.repeat(COMMAND_OUTPUT_MAX_BYTES + 1))
    expect(() => store.read('task', artifact.id)).toThrow('Unsafe or oversized')
    writeFileSync(path, 'owned')
    writeFileSync(path.replace(/\.log$/, '.json'), 'x'.repeat(33 * 1024))
    expect(() => store.get('task', artifact.id)).toThrow('Unsafe or oversized')
  })
})
