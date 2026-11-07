import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRememberTool, loadProjectMemory, MEMORY_FILE, MEMORY_MAX_CHARS } from './projectMemory'

let root: string
const context = { requestPermission: async () => ({ decision: 'allow' as const }) }
const remember = (note: unknown, onWrite?: Parameters<typeof createRememberTool>[0]['onWrite']) =>
  createRememberTool({ root, ...(onWrite ? { onWrite } : {}) }).execute({ note } as never, context)

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cubex-memory-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('saving a note', () => {
  it('creates the file, says who the notes are for, and reports the write for review', async () => {
    const onWrite = vi.fn()
    const result = await remember('Tests need --runInBand.', onWrite)
    expect(result.isError).toBeUndefined()
    const text = readFileSync(join(root, MEMORY_FILE), 'utf8')
    expect(text).toContain('# Project memory')
    expect(text).toContain('- Tests need --runInBand.')
    expect(onWrite).toHaveBeenCalledOnce()
    expect(onWrite.mock.calls[0]![1]).toBeNull()
    expect(onWrite.mock.calls[0]![2]).toBe(false)
  })

  it('adds to what is there, in its line endings, and does not repeat itself', async () => {
    mkdirSync(join(root, '.cubex'))
    writeFileSync(join(root, MEMORY_FILE), '# Mine\r\n\r\n- First rule\r\n')
    await remember('Second rule')
    expect(readFileSync(join(root, MEMORY_FILE), 'utf8')).toBe('# Mine\r\n\r\n- First rule\r\n- Second rule\r\n')
    expect((await remember('- second RULE')).content).toContain('already saved')
    expect(readFileSync(join(root, MEMORY_FILE), 'utf8').match(/rule/gi)).toHaveLength(2)
  })

  it('takes one short line only', async () => {
    for (const note of ['', undefined, 'two\nlines', 'x'.repeat(241)]) expect((await remember(note)).isError).toBe(true)
    expect(existsSync(join(root, MEMORY_FILE))).toBe(false)
  })

  it('refuses when full, and says what to do', async () => {
    mkdirSync(join(root, '.cubex'))
    writeFileSync(join(root, MEMORY_FILE), `- ${'x'.repeat(MEMORY_MAX_CHARS)}\n`)
    const result = await remember('One more')
    expect(result.isError).toBe(true)
    expect(result.content).toContain('full')
  })

  it('asks every time', () => {
    expect(createRememberTool({ root }).defaultPermission).toBe('ask')
  })
})

describe('reading the notes', () => {
  it('is nothing when there are none', () => {
    expect(loadProjectMemory(root)).toBeUndefined()
    mkdirSync(join(root, '.cubex'))
    writeFileSync(join(root, MEMORY_FILE), '# Project memory\n\nJust a heading and some prose.\n')
    expect(loadProjectMemory(root)).toBeUndefined()
  })

  it('takes only the notes, not whatever else the file holds', () => {
    mkdirSync(join(root, '.cubex'))
    writeFileSync(join(root, MEMORY_FILE), '# Title\nSome prose that is not a note.\n- Rule one\n  - Rule two\n')
    expect(loadProjectMemory(root)).toBe('- Rule one\n  - Rule two')
  })

  it('cannot fill the prompt, however large the file has grown', () => {
    mkdirSync(join(root, '.cubex'))
    writeFileSync(join(root, MEMORY_FILE), Array.from({ length: 2000 }, (_, i) => `- Rule number ${i}`).join('\n'))
    const notes = loadProjectMemory(root)!
    expect(notes.length).toBeLessThan(MEMORY_MAX_CHARS + 100)
    expect(notes).toContain('left out')
  })
})
