import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_RETRY_POLICY } from '@core/types'
import type { AIProvider, AIStreamEvent, ExecutableTool, ToolCall } from '@core/types'
import type { ChatEvent, ChatStartRequest, ToolActivity } from '@shared/ipc'
import type { DiagnoseHook, DiagnosticsReport } from './diagnostics/types'
import type { ProviderManager } from './ProviderManager'

/**
 * Post-edit diagnostics inside the agent loop: the model sees the new problems in the tool result, the window gets
 * them as the activity's summary, and the setting is honored on every edit. The checker itself is a stand-in here;
 * the real one is covered in diagnostics/.
 */

const mocks = vi.hoisted(() => ({
  dataRoot: '',
  workspace: '',
  afterEdit: 'errors' as string | undefined,
  report: undefined as unknown,
  hookCalls: [] as Array<{ root: string; files: string[] }>,
  warmed: [] as string[],
  failHook: false
}))
vi.mock('./paths', () => ({ dataDir: () => mocks.dataRoot }))
vi.mock('./db', () => ({
  conversationRepo: { get: (id: string) => (id === 'c1' ? { id, workspacePath: mocks.workspace, messages: [] } : null) }
}))
vi.mock('./config', () => ({
  getSettings: () => ({ general: { workspacePath: mocks.workspace }, mcpServers: [], hooks: [], ...(mocks.afterEdit ? { diagnostics: { afterEdit: mocks.afterEdit } } : {}) })
}))
vi.mock('./cost', () => ({ recordUsage: vi.fn() }))
vi.mock('./logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))
vi.mock('./tools/shellTool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools/shellTool')>()
  const fake = (): ExecutableTool => ({
    definition: { name: 'run_command', description: 'fake shell', inputSchema: { type: 'object' } },
    defaultPermission: 'ask',
    async execute() { return { toolUseId: '', content: 'exit 0' } }
  })
  return { ...actual, createShellTool: fake }
})
vi.mock('./mcp/McpManager', () => {
  class McpManager {
    static describe(): string | undefined { return undefined }
    async getTools(): Promise<ExecutableTool[]> { return [] }
    disposeAll(): void {}
  }
  return { McpManager }
})
// The real hook logic runs against a manager that records what it is asked and answers with `mocks.report`.
vi.mock('./diagnostics/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./diagnostics/service')>()
  const manager = {
    warm: (root: string) => { mocks.warmed.push(root) },
    createDiagnoseHook: (root: string): DiagnoseHook => async (files) => {
      mocks.hookCalls.push({ root, files: files.map((file) => file.abs) })
      if (mocks.failHook) throw new Error('the checker blew up')
      return mocks.report as DiagnosticsReport | undefined
    }
  }
  return { ...actual, afterEditDiagnoseHook: (root: string, enabled: () => boolean) => actual.afterEditDiagnoseHook(root, enabled, () => manager) }
})

import { ChatService } from './ChatService'

let root: string
let services: ChatService[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cubex-diag-chat-'))
  mocks.dataRoot = join(root, 'data')
  mocks.workspace = join(root, 'workspace')
  for (const dir of [mocks.dataRoot, mocks.workspace]) mkdirSync(dir)
  mocks.afterEdit = 'errors'
  mocks.report = undefined
  mocks.hookCalls = []
  mocks.warmed = []
  mocks.failHook = false
})
afterEach(() => {
  for (const service of services) { service.cancelAll(); service.dispose() }
  services = []
  rmSync(root, { recursive: true, force: true })
})

const policy = { primary: { providerId: 'p', model: 'm' }, fallbacks: [], fallbackEnabled: false, retry: { ...DEFAULT_RETRY_POLICY, enabled: false }, timeout: {} }

interface Run {
  events: ChatEvent[]
  /** Text of each tool result the model was shown, by tool call id. */
  results: Map<string, string>
}

type Step = ToolCall[] | string

/** A step may be a function: it runs when the model is asked for that move, after the previous call finished. */
async function turn(script: Array<Step | (() => Step)>): Promise<Run> {
  const events: ChatEvent[] = []
  const results = new Map<string, string>()
  let requests = 0
  const provider = {
    id: 'p',
    async *streamMessage(request: { messages: Array<{ content: unknown }> }): AsyncGenerator<AIStreamEvent> {
      for (const message of request.messages) {
        if (!Array.isArray(message.content)) continue
        for (const part of message.content as Array<{ type?: string; toolUseId?: string; content?: Array<{ text?: string }> }>) {
          if (part.type === 'tool_result' && part.toolUseId) results.set(part.toolUseId, (part.content ?? []).map((item) => item.text ?? '').join(''))
        }
      }
      const next = script[requests++] ?? 'done'
      const step = typeof next === 'function' ? next() : next
      if (typeof step === 'string') yield { type: 'text_delta', text: step }
      else for (const toolCall of step) yield { type: 'tool_call', toolCall }
    }
  } as unknown as AIProvider
  const service = new ChatService({ resolve: () => provider, getModelInfo: () => undefined } as unknown as ProviderManager, (event) => { events.push(event) })
  services.push(service)
  const request: ChatStartRequest = { streamId: 's1', conversationId: 'c1', messageId: 'u1', userText: 'go', fileToolsEnabled: true, permissionMode: 'bypass', policy }
  await service.start(request)
  await vi.waitFor(() => expect(events.some((e) => e.kind === 'stream' && (e.event.type === 'completed' || e.event.type === 'error'))).toBe(true), { timeout: 8000 })
  return { events, results }
}

const write = (id: string, path: string, content: string): ToolCall => ({ id, name: 'write_file', input: { path, content } })
const final = (run: Run, id: string): ToolActivity => run.events.flatMap((e) => (e.kind === 'tool' && e.tool.id === id ? [e.tool] : [])).at(-1)!

const problem = { path: 'src/a.ts', line: 1, col: 14, code: 'TS2322', message: "Type 'string' is not assignable to type 'number'." }
const withError: DiagnosticsReport = {
  text: `\n\nNew diagnostics (1 error):\nsrc/a.ts:1:14 error TS2322: ${problem.message}`,
  summary: { errors: 1, warnings: 0, items: [problem] }
}

describe('new problems after an edit', () => {
  it('shows the model the problems in the tool result and the window the summary', async () => {
    mocks.report = withError
    const run = await turn([[write('w', 'src/a.ts', 'export const a: number = "x"\n')], 'done'])
    expect(run.results.get('w')).toContain('New diagnostics (1 error):')
    expect(run.results.get('w')).toContain(`src/a.ts:1:14 error TS2322: ${problem.message}`)
    expect(run.results.get('w')).not.toContain('«diff')
    expect(final(run, 'w')).toMatchObject({ phase: 'done', diagnostics: { errors: 1, warnings: 0, items: [problem] } })
    expect(mocks.hookCalls).toEqual([{ root: mocks.workspace, files: [join(mocks.workspace, 'src/a.ts')] }])
  })

  it('warms the workspace for the turn, before any edit', async () => {
    const run = await turn(['no edits this turn'])
    expect(run.events.some((e) => e.kind === 'tool')).toBe(false)
    expect(mocks.warmed).toEqual([mocks.workspace])
  })

  it('carries a warnings-only report to the window without adding text for the model', async () => {
    mocks.report = { text: '', summary: { errors: 0, warnings: 2, items: [] } } satisfies DiagnosticsReport
    const run = await turn([[write('w', 'src/a.ts', 'export const a = 1\n')], 'done'])
    expect(run.results.get('w')).not.toContain('New diagnostics')
    expect(final(run, 'w').diagnostics).toEqual({ errors: 0, warnings: 2 })
  })

  it('leaves the result alone when the edit introduced nothing', async () => {
    const run = await turn([[write('w', 'src/a.ts', 'export const a = 1\n')], 'done'])
    expect(run.results.get('w')).not.toContain('New diagnostics')
    expect(final(run, 'w')).not.toHaveProperty('diagnostics')
    expect(mocks.hookCalls).toHaveLength(1)
  })

  it('never lets a failing checker fail the edit', async () => {
    mocks.failHook = true
    const run = await turn([[write('w', 'src/a.ts', 'export const a = 1\n')], 'done'])
    expect(final(run, 'w')).toMatchObject({ phase: 'done' })
    expect(final(run, 'w')).not.toHaveProperty('diagnostics')
  })

  it('drops a malformed summary rather than showing it', async () => {
    mocks.report = { text: '', summary: { errors: 'lots', warnings: 0 } }
    const run = await turn([[write('w', 'src/a.ts', 'export const a = 1\n')], 'done'])
    expect(final(run, 'w')).not.toHaveProperty('diagnostics')
  })

  it('does not report on a call that failed', async () => {
    mocks.report = withError
    writeFileSync(join(mocks.workspace, 'old.ts'), 'export const old = 1\n')
    // Overwriting a file that was never read fails, so there is nothing to check.
    const run = await turn([[write('w', 'old.ts', 'export const old = 2\n')], 'done'])
    expect(final(run, 'w').phase).toBe('error')
    expect(final(run, 'w')).not.toHaveProperty('diagnostics')
    expect(mocks.hookCalls).toEqual([])
  })
})

describe('the afterEdit setting', () => {
  it('turns the checks off: nothing is asked of the checker and nothing is added', async () => {
    mocks.afterEdit = 'off'
    mocks.report = withError
    const run = await turn([[write('w', 'src/a.ts', 'export const a: number = "x"\n')], 'done'])
    expect(run.results.get('w')).not.toContain('New diagnostics')
    expect(final(run, 'w')).not.toHaveProperty('diagnostics')
    expect(mocks.hookCalls).toEqual([])
    expect(mocks.warmed).toEqual([])
  })

  it('is read for each edit, so a change made mid-turn applies to the very next write', async () => {
    mocks.report = withError
    const run = await turn([
      [write('first', 'src/a.ts', 'export const a = 1\n')],
      // The person switches it off in Settings between the two edits.
      () => { mocks.afterEdit = 'off'; return [write('second', 'src/b.ts', 'export const b = 1\n')] },
      'done'
    ])
    expect(final(run, 'first').diagnostics).toBeDefined()
    expect(final(run, 'second')).not.toHaveProperty('diagnostics')
    expect(mocks.hookCalls.map((call) => call.files[0])).toEqual([join(mocks.workspace, 'src/a.ts')])
  })

  it('treats a missing setting as off, so a partial config never starts a worker', async () => {
    mocks.afterEdit = undefined
    mocks.report = withError
    const run = await turn([[write('w', 'src/a.ts', 'export const a = 1\n')], 'done'])
    expect(final(run, 'w')).not.toHaveProperty('diagnostics')
    expect(mocks.hookCalls).toEqual([])
  })
})
