import { describe, expect, it, vi } from 'vitest'
import type { DiagnosticItem, DiagnosticsStatus } from '@shared/ipc'
import { createDiagnosticsHandlers, type DiagnosticsHandlerDeps } from './handlers'

const WORKSPACE = 'C:\\work\\app'
const problem = (path: string, line = 1): DiagnosticItem => ({ path, line, col: 1, code: 'TS2322', message: 'boom' })

interface Setup {
  deps: DiagnosticsHandlerDeps
  getDiagnostics: ReturnType<typeof vi.fn>
  status: ReturnType<typeof vi.fn>
  created: () => number
}

function setup(over: Partial<DiagnosticsHandlerDeps> = {}, answers: Record<string, DiagnosticItem[]> = {}): Setup {
  let created = 0
  // Answers are keyed by the workspace-relative path with forward slashes, whichever way the caller spelled it.
  const relativeKey = (path = ''): string => path.replace(`${WORKSPACE}\\`, '').split('\\').join('/')
  const getDiagnostics = vi.fn(async (_root: string, path?: string) => answers[relativeKey(path)] ?? [])
  const status = vi.fn((): DiagnosticsStatus => ({ available: true, engine: 'typescript', version: '5.9.3' }))
  const deps: DiagnosticsHandlerDeps = {
    taskId: (value) => {
      if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error('Invalid task id.')
      return value
    },
    enabled: () => true,
    workspaceOf: (id) => (id === 'none' ? undefined : WORKSPACE),
    changedFiles: async () => [],
    inWorkspace: (workspace, path) => `${workspace}\\${path}`,
    manager: () => { created++; return { getDiagnostics, status, lastRoot: 'C:\\work\\last' } as unknown as ReturnType<DiagnosticsHandlerDeps['manager']> },
    ...over
  }
  return { deps, getDiagnostics, status, created: () => created }
}

describe('diagnosticsGet', () => {
  it('returns the problems the checker finds in one file of the workspace', async () => {
    const { deps, getDiagnostics } = setup({}, { 'src/a.ts': [problem('src/a.ts')] })
    expect(await createDiagnosticsHandlers(deps).get('c1', 'src\\a.ts')).toEqual([problem('src/a.ts')])
    expect(getDiagnostics).toHaveBeenCalledWith(WORKSPACE, `${WORKSPACE}\\src\\a.ts`, expect.any(AbortSignal))
  })

  it('rejects an id or a path that is not a bounded string', async () => {
    const handlers = createDiagnosticsHandlers(setup().deps)
    await expect(handlers.get(undefined)).rejects.toThrow('Invalid task id.')
    await expect(handlers.get({ id: 'c1' })).rejects.toThrow('Invalid task id.')
    await expect(handlers.get('c1', 42)).rejects.toThrow('Invalid file path.')
    await expect(handlers.get('c1', '   ')).rejects.toThrow('Invalid file path.')
    await expect(handlers.get('c1', 'a'.repeat(5000))).rejects.toThrow('Invalid file path.')
    await expect(handlers.get('c1', 'src/a.ts\0.png')).rejects.toThrow('Invalid file path.')
  })

  it('reports a path that leaves the workspace and never reaches the checker', async () => {
    const { deps, getDiagnostics } = setup({ inWorkspace: () => { throw new Error('Path escapes the workspace.') } })
    await expect(createDiagnosticsHandlers(deps).get('c1', '..\\..\\secrets.ts')).rejects.toThrow('escapes the workspace')
    expect(getDiagnostics).not.toHaveBeenCalled()
  })

  it('does not let a checker that fails reach the window as an error', async () => {
    const { deps, getDiagnostics } = setup()
    getDiagnostics.mockRejectedValueOnce(new Error('worker exploded'))
    expect(await createDiagnosticsHandlers(deps).get('c1', 'src/a.ts')).toEqual([])
  })

  describe('with no path', () => {

    it('looks at no more than 40 files and returns no more than 500 problems', async () => {
      const many = Array.from({ length: 60 }, (_, index) => `src/f${index}.ts`)
      const { deps, getDiagnostics } = setup({ changedFiles: async () => many }, Object.fromEntries(many.map((file) => [file, Array.from({ length: 30 }, (_, line) => problem(file, line + 1))])))
      const items = await createDiagnosticsHandlers(deps).get('c1')
      expect(getDiagnostics.mock.calls.length).toBeLessThanOrEqual(40)
      expect(items.length).toBe(500)
    })
  })
})
