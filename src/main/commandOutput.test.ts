import { createHash, randomUUID } from 'node:crypto'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMMAND_OUTPUT_MAX_ARTIFACTS, COMMAND_OUTPUT_MAX_BYTES, CommandOutputStore } from './commandOutput'
import { createReadCommandOutputTool } from './tools/readCommandOutputTool'

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

  it('preserves partial text and failure information for cancelled and timed-out captures', () => {
    for (const status of ['cancelled', 'timed_out'] as const) {
      const writer = store.create('task', { command: status })
      writer.append('progress before stopping\n')
      const result = writer.finish({ status, error: 'Process stopped.' })
      expect(writer.finish({ status: 'completed' })).toEqual(result)
      expect(() => writer.append('late')).toThrow('already closed')
      expect(store.read('task', writer.id)).toMatchObject({ text: 'progress before stopping\n', artifact: { status, error: 'Process stopped.' } })
    }
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

  it('keeps interrupted output readable and revealable when its recovery receipt cannot be written', () => {
    const artifact = save('durable output prefix')
    const path = store.revealPath('task', artifact.id)
    writeFileSync(path.replace(/\.log$/, '.json'), JSON.stringify({
      ...artifact, status: 'running', completedAt: undefined, exitCode: undefined, capturedBytes: 0, totalBytes: 0
    }))
    const restarted = new CommandOutputStore(root)
    const receiptWriter = restarted as unknown as { atomicMetadata: (...args: unknown[]) => void }
    const write = vi.spyOn(receiptWriter, 'atomicMetadata').mockImplementation(() => { throw new Error('ENOSPC: no space left on device') })
    try {
      expect(restarted.read('task', artifact.id)).toMatchObject({
        text: 'durable output prefix', artifact: { status: 'interrupted', capturedBytes: 21 }
      })
      expect(restarted.revealPath('task', artifact.id)).toBe(path)
      expect(restarted.list('task')).toContainEqual(expect.objectContaining({ id: artifact.id, status: 'interrupted' }))
      expect(write).toHaveBeenCalled()
    } finally { write.mockRestore() }
  })

  it('retains the newest 50 outputs and never evicts an active capture', () => {
    const active = store.create('task', { command: 'active' })
    try {
      const oldest = save('oldest completed')
      for (let index = 0; index < COMMAND_OUTPUT_MAX_ARTIFACTS; index++) save(`output ${index}`)
      expect(store.list('task')).toHaveLength(COMMAND_OUTPUT_MAX_ARTIFACTS)
      expect(store.get('task', oldest.id)).toBeNull()
      expect(store.get('task', active.id)?.status).toBe('running')
      expect(store.list('task')[0]?.command).toBe('test command')
      expect(readdirSync(dirname(store.revealPath('task', active.id))).filter((name) => name.endsWith('.log'))).toHaveLength(COMMAND_OUTPUT_MAX_ARTIFACTS)
    } finally { active.finish({ status: 'cancelled' }) }
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

  it('lists healthy outputs and still enforces retention when one receipt is damaged', () => {
    const damaged = save('old output')
    const damagedPath = store.revealPath('task', damaged.id).replace(/\.log$/, '.json')
    writeFileSync(damagedPath, '{broken json')
    const healthy = save('healthy output')
    expect(store.list('task').map((item) => item.id)).toEqual([healthy.id])
    expect(() => store.read('task', damaged.id)).toThrow()
    for (let index = 0; index < COMMAND_OUTPUT_MAX_ARTIFACTS; index++) save(`later ${index}`)
    expect(store.list('task')).toHaveLength(COMMAND_OUTPUT_MAX_ARTIFACTS)
    expect(store.get('task', damaged.id)).toBeNull()
  })

  it.each([{ offset: -1 }, { offset: NaN }, { offset: 0.5 }, { limit: Infinity }, { limit: 3 }, { limit: 65_537 }])('rejects invalid page bounds %#', (options) => {
    const artifact = save('output')
    expect(() => store.read('task', artifact.id, options)).toThrow('Output offset')
  })

  it('makes a read-only tool scoped to one task and preserves continuation metadata', async () => {
    const artifact = save('abcdefghij')
    const tool = createReadCommandOutputTool(store, 'task')
    const context = { requestPermission: async () => ({ decision: 'allow' as const }) }
    expect(tool.defaultPermission).toBe('allow')
    const result = await tool.execute({ output_id: artifact.id, limit: 4 }, context)
    expect(JSON.parse(String(result.content))).toMatchObject({ text: 'abcd', nextOffset: 4, eof: false })
    expect((await createReadCommandOutputTool(store, 'foreign').execute({ output_id: artifact.id }, context)).isError).toBe(true)
    expect((await tool.execute({ output_id: artifact.id, path: '../anything' }, context)).isError).toBe(true)
    expect((await tool.execute({ output_id: randomUUID() }, context)).isError).toBe(true)
  })
})
