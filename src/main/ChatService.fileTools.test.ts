import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_RETRY_POLICY } from '@core/types'
import type { AIProvider, AIStreamEvent, ExecutableTool, ToolCall } from '@core/types'
import type { ChatEvent, ChatStartRequest, PermissionAsk, PermissionDecision, PermissionMode, ToolActivity } from '@shared/ipc'
import type { ProviderManager } from './ProviderManager'

/**
 * multi_edit and apply_patch inside the agent loop: permission class, acceptEdits and
 * protected-path handling, plan mode, titles, per-file activity, and retry bookkeeping.
 */

const mocks = vi.hoisted(() => ({ dataRoot: '', workspace: '' }))
vi.mock('./paths', () => ({ dataDir: () => mocks.dataRoot }))
vi.mock('./db', () => ({
  conversationRepo: { get: (id: string) => (id === 'c1' ? { id, workspacePath: mocks.workspace, messages: [] } : null) }
}))
vi.mock('./config', () => ({ getSettings: () => ({ general: { workspacePath: mocks.workspace }, mcpServers: [], hooks: [] }) }))
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

import { ChatService } from './ChatService'

let root: string
let services: ChatService[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cubex-filetools-chat-'))
  mocks.dataRoot = join(root, 'data')
  mocks.workspace = join(root, 'workspace')
  for (const dir of [mocks.dataRoot, mocks.workspace]) mkdirSync(dir)
})
afterEach(() => {
  for (const service of services) { service.cancelAll(); service.dispose() }
  services = []
  rmSync(root, { recursive: true, force: true })
})

const policy = { primary: { providerId: 'p', model: 'm' }, fallbacks: [], fallbackEnabled: false, retry: { ...DEFAULT_RETRY_POLICY, enabled: false }, timeout: {} }
type Step = ToolCall[] | string

interface Run {
  events: ChatEvent[]
  /** Text of each tool result the model was shown, by tool call id. */
  results: Map<string, string>
}

/** One scripted turn. Permission asks are answered from `answers` in order (default deny). */
async function turn(script: Step[], mode: PermissionMode = 'default', answers: PermissionDecision[] = []): Promise<Run> {
  const events: ChatEvent[] = []
  const results = new Map<string, string>()
  let requests = 0
  const pending = [...answers]
  const provider = {
    id: 'p',
    async *streamMessage(request: { messages: Array<{ content: unknown }> }): AsyncGenerator<AIStreamEvent> {
      for (const message of request.messages) {
        if (!Array.isArray(message.content)) continue
        for (const part of message.content as Array<{ type?: string; toolUseId?: string; content?: Array<{ text?: string }> }>) {
          if (part.type === 'tool_result' && part.toolUseId) results.set(part.toolUseId, (part.content ?? []).map((item) => item.text ?? '').join(''))
        }
      }
      const step = script[requests++] ?? 'done'
      if (typeof step === 'string') yield { type: 'text_delta', text: step }
      else for (const toolCall of step) yield { type: 'tool_call', toolCall }
    }
  } as unknown as AIProvider
  const service: ChatService = new ChatService({ resolve: () => provider, getModelInfo: () => undefined } as unknown as ProviderManager, (event) => {
    events.push(event)
    if (event.kind === 'permission') {
      const decision = pending.shift() ?? 'deny'
      queueMicrotask(() => service.resolvePermission(event.ask.id, decision))
    }
  })
  services.push(service)
  const request: ChatStartRequest = { streamId: 's1', conversationId: 'c1', messageId: 'u1', userText: 'go', fileToolsEnabled: true, permissionMode: mode, policy }
  await service.start(request)
  await vi.waitFor(() => expect(events.some((e) => e.kind === 'stream' && (e.event.type === 'completed' || e.event.type === 'error'))).toBe(true), { timeout: 8000 })
  return { events, results }
}

const asks = (run: Run): PermissionAsk[] => run.events.flatMap((e) => (e.kind === 'permission' ? [e.ask] : []))
const tools = (run: Run, id: string): ToolActivity[] => run.events.flatMap((e) => (e.kind === 'tool' && e.tool.id === id ? [e.tool] : []))
const final = (run: Run, id: string): ToolActivity => tools(run, id).at(-1)!
const file = (rel: string): string => join(mocks.workspace, rel)
const put = (rel: string, content: string): void => {
  mkdirSync(join(file(rel), '..'), { recursive: true })
  writeFileSync(file(rel), content)
}
const read = (id: string, path: string): ToolCall => ({ id, name: 'read_file', input: { path } })
const patchCall = (id: string, ...lines: string[]): ToolCall => ({ id, name: 'apply_patch', input: { patch: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') } })
const multiCall = (id: string, path: string, edits: Array<{ old_string: string; new_string: string }>): ToolCall => ({ id, name: 'multi_edit', input: { path, edits } })

describe('permission classes', () => {
  it('asks in default mode and applies the patch only after approval', async () => {
    put('a.txt', 'one\ntwo\n')
    const run = await turn([[read('r', 'a.txt')], [patchCall('p', '*** Update File: a.txt', ' one', '-two', '+TWO')], 'done'], 'default', ['allow'])
    expect(asks(run)).toHaveLength(1)
    expect(asks(run)[0]).toMatchObject({ toolName: 'apply_patch' })
    // The reviewer sees the patch itself, with real line breaks, not a JSON-escaped string.
    expect(asks(run)[0]!.detail).toContain('*** Begin Patch\n*** Update File: a.txt\n one\n-two\n+TWO\n*** End Patch')
    expect(readFileSync(file('a.txt'), 'utf8')).toBe('one\nTWO\n')
  })

  it('does not change anything when the user denies', async () => {
    put('a.txt', 'one\n')
    const run = await turn([[read('r', 'a.txt')], [patchCall('p', '*** Update File: a.txt', '-one', '+ONE')], [multiCall('m', 'a.txt', [{ old_string: 'one', new_string: 'ONE' }])], 'done'], 'default', ['deny', 'deny'])
    expect(asks(run).map((ask) => ask.toolName)).toEqual(['apply_patch', 'multi_edit'])
    expect(readFileSync(file('a.txt'), 'utf8')).toBe('one\n')
    expect(final(run, 'p').phase).toBe('error')
  })

  it('auto-approves both in acceptEdits mode', async () => {
    put('a.txt', 'one\ntwo\n')
    put('b.txt', 'x\n')
    const run = await turn([
      [read('r1', 'a.txt'), read('r2', 'b.txt')],
      [patchCall('p', '*** Update File: a.txt', ' one', '-two', '+TWO', '*** Add File: c.txt', '+new')],
      [multiCall('m', 'b.txt', [{ old_string: 'x', new_string: 'X' }])],
      'done'
    ], 'acceptEdits')
    expect(asks(run)).toEqual([])
    expect(readFileSync(file('a.txt'), 'utf8')).toBe('one\nTWO\n')
    expect(readFileSync(file('c.txt'), 'utf8')).toBe('new\n')
    expect(readFileSync(file('b.txt'), 'utf8')).toBe('X\n')
  })

  it('still asks in acceptEdits mode when a protected path is named anywhere in a patch', async () => {
    put('a.txt', 'one\n')
    for (const [name, lines] of [
      ['add', ['*** Add File: a2.txt', '+safe', '*** Add File: .git/hooks/pre-commit', '+evil']],
      ['move', ['*** Update File: a.txt', '*** Move to: .claude/settings.json']],
      ['delete', ['*** Delete File: .vscode/tasks.json']],
      ['backslash', ['*** Add File: .husky\\pre-commit', '+evil']]
    ] as const) {
      const run = await turn([[read('r', 'a.txt')], [patchCall('p', ...lines)], 'done'], 'acceptEdits', ['deny'])
      expect(asks(run), name).toHaveLength(1)
      expect(asks(run)[0]!.risks?.join(' '), name).toMatch(/Protected path/)
    }
    expect(existsSync(file('.git/hooks/pre-commit'))).toBe(false)
    expect(existsSync(file('a2.txt'))).toBe(false)
  })

  it('treats multi_edit on a protected file like edit_file', async () => {
    put('.git/config', '[core]\n')
    const run = await turn([[read('r', '.git/config')], [multiCall('m', '.git/config', [{ old_string: '[core]', new_string: '[evil]' }])], 'done'], 'acceptEdits', ['deny'])
    expect(asks(run)).toHaveLength(1)
    expect(asks(run)[0]!.risks?.join(' ')).toMatch(/Protected path/)
    expect(readFileSync(file('.git/config'), 'utf8')).toBe('[core]\n')
  })

  it('blocks both in plan mode', async () => {
    put('a.txt', 'one\n')
    const run = await turn([[read('r', 'a.txt')], [patchCall('p', '*** Update File: a.txt', '-one', '+ONE'), multiCall('m', 'a.txt', [{ old_string: 'one', new_string: 'ONE' }])], 'done'], 'plan')
    expect(asks(run)).toEqual([])
    expect(final(run, 'p')).toMatchObject({ phase: 'error', detail: 'Blocked in plan mode' })
    expect(final(run, 'm')).toMatchObject({ phase: 'error', detail: 'Blocked in plan mode' })
    expect(readFileSync(file('a.txt'), 'utf8')).toBe('one\n')
  })
})

describe('tool activity', () => {
  it('titles the calls', async () => {
    put('a.txt', 'one\ntwo\n')
    put('b.txt', 'x\n')
    const run = await turn([
      [read('r1', 'a.txt'), read('r2', 'b.txt')],
      [multiCall('m', 'a.txt', [{ old_string: 'one', new_string: '1' }, { old_string: 'two', new_string: '2' }])],
      [patchCall('p1', '*** Update File: b.txt', '-x', '+X')],
      [patchCall('p2', '*** Add File: n1.txt', '+1', '*** Add File: n2.txt', '+2', '*** Delete File: b.txt')],
      'done'
    ], 'acceptEdits')
    expect(final(run, 'm').title).toBe('Edit a.txt (2 edits)')
    expect(final(run, 'p1').title).toBe('Patch b.txt')
    expect(final(run, 'p2').title).toBe('Patch 3 files')
  })

  it('reports per-file activity and totals for a patch, and hides the markers from the model', async () => {
    put('a.txt', 'one\ntwo\n')
    put('gone.txt', 'bye\n')
    const run = await turn([
      [read('r1', 'a.txt'), read('r2', 'gone.txt')],
      [patchCall('p', '*** Update File: a.txt', ' one', '-two', '+TWO', '+TWO-B', '*** Delete File: gone.txt', '*** Add File: sub/new.txt', '+n')],
      'done'
    ], 'acceptEdits')
    const activity = final(run, 'p')
    expect(activity.phase).toBe('done')
    expect(activity.files).toEqual([
      { path: 'a.txt', status: 'modified', added: 2, removed: 1, diff: expect.stringContaining('+TWO-B') },
      { path: 'gone.txt', status: 'deleted', added: 0, removed: 1, diff: expect.stringContaining('-bye') },
      { path: 'sub/new.txt', status: 'added', added: 1, removed: 0, diff: expect.stringContaining('+n') }
    ])
    expect(activity).toMatchObject({ added: 3, removed: 2 })
    expect(activity.detail).toContain('Applied patch: 3 files changed')
    expect(activity.detail).not.toContain('«')
    expect(run.results.get('p')).toContain('Applied patch: 3 files changed (+3 -2)')
    expect(run.results.get('p')).not.toContain('«')
  })

  it('keeps single-file edits free of the files field', async () => {
    put('a.txt', 'one\n')
    const run = await turn([[read('r', 'a.txt')], [multiCall('m', 'a.txt', [{ old_string: 'one', new_string: 'ONE' }])], 'done'], 'acceptEdits')
    const activity = final(run, 'm')
    expect(activity).toMatchObject({ phase: 'done', added: 1, removed: 1 })
    expect(activity).not.toHaveProperty('files')
    expect(activity.diff).toContain('+ONE')
  })
})

describe('retries', () => {
  it('lets the identical patch run again once the missing read has happened', async () => {
    put('a.txt', 'one\n')
    const same = patchCall('p', '*** Update File: a.txt', '-one', '+ONE')
    const run = await turn([
      [same],
      [read('r', 'a.txt')],
      [{ ...same, id: 'p-retry' }],
      'done'
    ], 'acceptEdits')
    expect(final(run, 'p').phase).toBe('error')
    expect(final(run, 'p').detail).toContain('have not read')
    expect(final(run, 'p-retry').phase).toBe('done')
    expect(readFileSync(file('a.txt'), 'utf8')).toBe('ONE\n')
  })

  it('still stops an identical failing patch that nothing has changed', async () => {
    put('a.txt', 'one\n')
    const bad = patchCall('p', '*** Update File: a.txt', '-nope', '+x')
    const run = await turn([[read('r', 'a.txt')], [bad], [{ ...bad, id: 'p2' }], 'done'], 'acceptEdits')
    expect(final(run, 'p').phase).toBe('error')
    expect(final(run, 'p2').detail).toContain('already failed')
  })
})
