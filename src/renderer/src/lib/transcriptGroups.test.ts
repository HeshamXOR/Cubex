import { describe, expect, it } from 'vitest'
import type { DiagnosticItem, DiagnosticsSummary, ToolActivity } from '../../../shared/ipc'
import type { MessageTranscriptBlock } from '../../../shared/messageTranscript'
import { editedFiles, exploreSummary, groupPhase, groupTranscript, toolTarget } from './transcriptGroups'

const tool = (id: string, name: string, extra: Partial<ToolActivity> = {}): MessageTranscriptBlock =>
  ({ type: 'tool', tool: { id, name, phase: 'done', ...extra } })
const text = (value: string): MessageTranscriptBlock => ({ type: 'text', text: value })

describe('toolTarget', () => {
  it('drops the verb and the subagent prefix', () => {
    expect(toolTarget({ name: 'edit_file', title: 'Edit src/upload/client.ts' })).toBe('src/upload/client.ts')
    expect(toolTarget({ name: 'run_command', title: 'Run npm test -- upload' })).toBe('npm test -- upload')
    expect(toolTarget({ name: 'read_file', title: 'Subagent: Read README.md' })).toBe('README.md')
    expect(toolTarget({ name: 'skill', title: 'Use review' })).toBe('Use review')
    expect(toolTarget({ name: 'read_file' })).toBe('')
  })
})

describe('groupTranscript', () => {
  it('folds consecutive reads and searches into one explore row', () => {
    const segments = groupTranscript([
      tool('1', 'read_file', { title: 'Read a.ts' }),
      tool('2', 'search_files', { title: 'Search foo' }),
      tool('3', 'list_files', { title: 'List src' })
    ])
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ kind: 'explore', key: 'explore:1' })
    expect((segments[0] as { tools: unknown[] }).tools).toHaveLength(3)
  })

  it('keeps reading order around prose and breaks a group at text', () => {
    const segments = groupTranscript([
      tool('1', 'read_file'), text('Looking at it.'), tool('2', 'read_file'), tool('3', 'edit_file', { title: 'Edit a.ts' })
    ])
    expect(segments.map((segment) => segment.kind)).toEqual(['explore', 'text', 'explore', 'edit'])
  })

  it('groups edits of different kinds together and web lookups separately', () => {
    const segments = groupTranscript([
      tool('1', 'write_file', { title: 'Write a.ts' }), tool('2', 'edit_file', { title: 'Edit b.ts' }),
      tool('3', 'web_search'), tool('4', 'web_fetch')
    ])
    expect(segments.map((segment) => segment.kind)).toEqual(['edit', 'web'])
  })

  it('shows each command on its own row and other tools as plain rows', () => {
    const segments = groupTranscript([tool('1', 'run_command'), tool('2', 'run_command'), tool('3', 'skill')])
    expect(segments.map((segment) => segment.kind)).toEqual(['command', 'command', 'tool'])
  })

  it('puts a single plan marker where the first checklist call was and drops later ones', () => {
    const segments = groupTranscript([text('Plan.'), tool('1', 'todo_write'), tool('2', 'read_file'), tool('3', 'todo_write')])
    expect(segments.map((segment) => segment.kind)).toEqual(['text', 'todos', 'explore'])
  })

  it('flags only the last piece of content as last, ignoring checklist calls after it', () => {
    const segments = groupTranscript([{ type: 'reasoning', text: 'hm' }, text('Answer'), tool('1', 'todo_write')])
    expect(segments.filter((segment) => segment.kind === 'text' || segment.kind === 'reasoning').map((segment) => (segment as { last: boolean }).last)).toEqual([false, true])
  })

  it('does not group across a different tool kind', () => {
    const segments = groupTranscript([tool('1', 'read_file'), tool('2', 'edit_file', { title: 'Edit a.ts' }), tool('3', 'read_file')])
    expect(segments.map((segment) => segment.kind)).toEqual(['explore', 'edit', 'explore'])
  })
})

describe('editedFiles', () => {
  it('adds up several edits of one file and keeps new files new', () => {
    const files = editedFiles([
      { id: '1', name: 'write_file', phase: 'done', title: 'Write src/a.ts', added: 10 },
      { id: '2', name: 'edit_file', phase: 'done', title: 'Edit src/a.ts', added: 2, removed: 1 },
      { id: '3', name: 'edit_file', phase: 'done', title: 'Edit src/b.ts', added: 1, removed: 1 }
    ])
    expect(files).toEqual([
      { path: 'src/a.ts', status: 'added', added: 12, removed: 1, diff: undefined, phase: 'done', ids: ['1', '2'] },
      { path: 'src/b.ts', status: 'modified', added: 1, removed: 1, diff: undefined, phase: 'done', ids: ['3'] }
    ])
  })

  it('marks removals and lets the running phase win', () => {
    const files = editedFiles([
      { id: '1', name: 'remove_file', phase: 'running', title: 'Remove old.ts' },
      { id: '2', name: 'edit_file', phase: 'done', title: 'Edit x.ts', added: 1 }
    ])
    expect(files[0]).toMatchObject({ path: 'old.ts', status: 'deleted', phase: 'running' })
  })

  it('expands a multi-file call into one entry per file', () => {
    const files = editedFiles([
      { id: '1', name: 'apply_patch', phase: 'done', title: 'Patch 2 files', files: [
        { path: 'a.ts', status: 'added', added: 4, removed: 0 }, { path: 'b.ts', added: 1, removed: 2 }
      ] } as unknown as ToolActivity
    ])
    expect(files.map((file) => [file.path, file.status, file.added, file.removed])).toEqual([
      ['a.ts', 'added', 4, 0], ['b.ts', 'modified', 1, 2]
    ])
  })

  describe('problems an edit introduced', () => {
    const error = (path: string, line: number): DiagnosticItem => ({ path, line, col: 1, code: 'TS2322', message: `Problem at line ${line}.` })
    const report = (...items: DiagnosticItem[]): DiagnosticsSummary => ({ errors: items.length, warnings: 0, items })

    it('carries the report of an edit onto its file', () => {
      const summary: DiagnosticsSummary = { errors: 1, warnings: 2, items: [error('src/a.ts', 4)] }
      const files = editedFiles([{ id: '1', name: 'edit_file', phase: 'done', title: 'Edit src/a.ts', diagnostics: summary }])
      expect(files[0]?.diagnostics).toEqual(summary)
    })

    it('leaves files without a report without one', () => {
      const files = editedFiles([{ id: '1', name: 'edit_file', phase: 'done', title: 'Edit src/a.ts' }])
      expect(files[0]?.diagnostics).toBeUndefined()
    })

    it('shows what the latest finished edit of a file reported, so a fix clears the chip', () => {
      const first = report(error('src/a.ts', 4))
      const fixed = editedFiles([
        { id: '1', name: 'edit_file', phase: 'done', title: 'Edit src/a.ts', diagnostics: first },
        { id: '2', name: 'edit_file', phase: 'done', title: 'Edit src/a.ts' }
      ])
      expect(fixed[0]?.diagnostics).toBeUndefined()
      const second = report(error('src/a.ts', 9), error('src/a.ts', 12))
      const worse = editedFiles([
        { id: '1', name: 'edit_file', phase: 'done', title: 'Edit src/a.ts', diagnostics: first },
        { id: '2', name: 'edit_file', phase: 'done', title: 'Edit src/a.ts', diagnostics: second }
      ])
      expect(worse[0]?.diagnostics).toEqual(second)
    })

    it('keeps an earlier report while a later edit of the file is still running', () => {
      const first = report(error('src/a.ts', 4))
      const files = editedFiles([
        { id: '1', name: 'edit_file', phase: 'done', title: 'Edit src/a.ts', diagnostics: first },
        { id: '2', name: 'edit_file', phase: 'running', title: 'Edit src/a.ts' }
      ])
      expect(files[0]).toMatchObject({ phase: 'running', diagnostics: first })
    })

    it('gives each file of a patch its own share', () => {
      const a = error('src/a.ts', 3)
      const b1 = error('src/b.ts', 7)
      const b2 = error('src/b.ts', 8)
      const files = editedFiles([
        {
          id: '1', name: 'apply_patch', phase: 'done', title: 'Patch 3 files',
          files: [{ path: 'src/a.ts', added: 1 }, { path: 'src/b.ts', added: 2 }, { path: 'src/c.ts', added: 1 }],
          diagnostics: {
            errors: 3, warnings: 1, items: [a, b1, b2],
            files: [{ path: 'src/a.ts', errors: 1, warnings: 1 }, { path: 'src/b.ts', errors: 2, warnings: 0 }]
          }
        } as unknown as ToolActivity
      ])
      expect(files.map((file) => file.diagnostics)).toEqual([
        { errors: 1, warnings: 1, items: [a] },
        { errors: 2, warnings: 0, items: [b1, b2] },
        undefined
      ])
    })
  })
})

describe('exploreSummary and groupPhase', () => {
  it('counts distinct files, searches and folders', () => {
    const summary = exploreSummary([
      { id: '1', name: 'read_file', phase: 'done', title: 'Read a.ts' }, { id: '2', name: 'read_file', phase: 'done', title: 'Read a.ts' },
      { id: '3', name: 'read_file', phase: 'done', title: 'Read b.ts' }, { id: '4', name: 'search_files', phase: 'done' },
      { id: '5', name: 'glob_files', phase: 'done' }, { id: '6', name: 'list_files', phase: 'done' }
    ])
    expect(summary).toEqual({ files: ['a.ts', 'b.ts'], searches: 2, folders: 1 })
  })

  it('reports the most active phase of a group', () => {
    expect(groupPhase([{ phase: 'done' }, { phase: 'running' }])).toBe('running')
    expect(groupPhase([{ phase: 'done' }, { phase: 'queued' }])).toBe('queued')
    expect(groupPhase([{ phase: 'done' }, { phase: 'error' }])).toBe('error')
    expect(groupPhase([{ phase: 'done' }])).toBe('done')
  })
})
