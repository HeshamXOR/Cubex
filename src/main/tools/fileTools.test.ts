import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileTools, parseDiffMarker } from './fileTools'
import type { ToolExecutionContext } from '@core/types'

const ctx: ToolExecutionContext = { requestPermission: async () => ({ decision: 'allow' }) }
let root: string
let tools: ReturnType<typeof createFileTools>
const tool = (name: string) => tools.find((t) => t.definition.name === name)!

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cubex-ft-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'README.md'), '# Hello\nworld\nCubex rocks')
  writeFileSync(join(root, 'src', 'app.ts'), 'export const x = 1\n// TODO: fix\n')
  tools = createFileTools(root)
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('file tools', () => {
  it('lists files, folders first', async () => {
    const r = await tool('list_files').execute({ path: '.' }, ctx)
    expect(r.isError).toBeFalsy()
    expect(String(r.content)).toContain('src/')
    expect(String(r.content)).toContain('README.md')
  })

  it('reads a file', async () => {
    const r = await tool('read_file').execute({ path: 'README.md' }, ctx)
    expect(String(r.content)).toContain('Cubex rocks')
  })

  it('searches file contents', async () => {
    const r = await tool('search_files').execute({ query: 'TODO' }, ctx)
    expect(String(r.content)).toMatch(/app\.ts:2/)
  })

  it('writes a file and reports diff stats', async () => {
    const r = await tool('write_file').execute({ path: 'note.txt', content: 'a\nb\nc' }, ctx)
    expect(r.isError).toBeFalsy()
    const diff = parseDiffMarker(String(r.content))
    expect(diff).toEqual({ added: 3, removed: 0 })
    const back = await tool('read_file').execute({ path: 'note.txt' }, ctx)
    expect(String(back.content)).toBe('a\nb\nc')
  })

  it('rejects path traversal outside the workspace', async () => {
    const r = await tool('read_file').execute({ path: '../../etc/passwd' }, ctx)
    expect(r.isError).toBe(true)
    expect(String(r.content)).toMatch(/escapes the workspace/i)
  })

  it('marks write_file as ask (permission-gated)', () => {
    expect(tool('write_file').defaultPermission).toBe('ask')
    expect(tool('read_file').defaultPermission).toBe('allow')
  })
})
