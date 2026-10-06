import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_RETRY_POLICY } from '@core/types'
import type { AIProvider, AIRequest, AIStreamEvent } from '@core/types'
import type { BackgroundTask, ChatEvent, ChatStartRequest } from '@shared/ipc'
import type { ProviderManager } from './ProviderManager'

/**
 * Stop on a turn, through the real agent loop and real processes: it ends what that turn started and
 * nothing else, a dev server from an earlier turn keeps running, and the window keeps hearing about a
 * task after the turn that started it is over.
 */
const mocks = vi.hoisted(() => ({ dataRoot: '', workspace: '', shell: undefined as string | undefined }))
vi.mock('./paths', () => ({ dataDir: () => mocks.dataRoot }))
vi.mock('./db', () => ({ conversationRepo: { get: (id: string) => ({ id, workspacePath: mocks.workspace, messages: [] }) } }))
vi.mock('./config', () => ({
  getSettings: () => ({ general: { workspacePath: mocks.workspace }, mcpServers: [], hooks: [], ...(mocks.shell ? { shell: { preferred: mocks.shell } } : {}) })
}))
vi.mock('./cost', () => ({ recordUsage: vi.fn() }))
vi.mock('./logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))

import { ChatService } from './ChatService'

const SERVER = 'node -e "console.log(\'listening on port 4010\'); setInterval(()=>{}, 1000)"'
const SLEEPER = 'node -e "setInterval(()=>{}, 1000)"'

let service: ChatService | undefined
let events: ChatEvent[]
let requests: AIRequest[]
/** What the model says next, one entry per request it receives. */
let script: AIStreamEvent[][]

beforeEach(() => {
  mocks.dataRoot = mkdtempSync(join(tmpdir(), 'cubex-tasks-chat-'))
  mocks.workspace = join(mocks.dataRoot, 'workspace')
  mocks.shell = undefined
  mkdirSync(mocks.workspace)
  events = []
  requests = []
  script = []
})
afterEach(async () => {
  const pids = (service?.processManager.list() ?? []).flatMap((task) => task.pid === undefined ? [] : [task.pid])
  service?.cancelAll()
  service?.dispose()
  service = undefined
  // A server still holds the workspace folder open until its process is really gone.
  await vi.waitFor(() => expect(pids.filter(alive)).toEqual([]), { timeout: 8_000 })
  // Removing the folder is housekeeping. Antivirus can hold a handle on Windows for longer than the retries
  // wait, and a temp folder left behind must not fail a test whose assertions have already passed.
  try {
    rmSync(mocks.dataRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  } catch {
    // The operating system clears the temp folder eventually.
  }
})

function chatService(): ChatService {
  const provider = {
    id: 'primary',
    streamMessage: async function* (request: AIRequest): AsyncGenerator<AIStreamEvent> {
      requests.push(structuredClone(request))
      for (const event of script.shift() ?? [{ type: 'text_delta', text: 'Done.' }]) yield event
    }
  } as unknown as AIProvider
  const manager = { resolve: (id: string) => id === 'primary' ? provider : undefined, getModelInfo: () => undefined } as unknown as ProviderManager
  service = new ChatService(manager, (event) => { events.push(event) })
  return service
}

function request(streamId: string): ChatStartRequest {
  return {
    streamId, conversationId: 'task', userText: 'Go', fileToolsEnabled: true, permissionMode: 'bypass',
    policy: { primary: { providerId: 'primary', model: 'test' }, fallbacks: [], fallbackEnabled: false, retry: { ...DEFAULT_RETRY_POLICY, enabled: false }, timeout: {} }
  }
}

const runCommand = (id: string, input: Record<string, string | number | boolean>): AIStreamEvent => ({ type: 'tool_call', toolCall: { id, name: 'run_command', input } })
const useTools: AIStreamEvent = { type: 'stop', stopReason: 'tool_use' }

async function finished(streamId: string): Promise<void> {
  await vi.waitFor(() => expect(events.some((event) => event.streamId === streamId && event.kind === 'stream' && event.event.type === 'completed')).toBe(true), { timeout: 8_000 })
}

/** The turn is blocked on this command: it started and has not reported back. */
async function commandInFlight(streamId: string, callId: string): Promise<void> {
  await vi.waitFor(() => expect(events.some((event) => event.streamId === streamId && event.kind === 'tool' && event.tool.id === callId && event.tool.phase === 'running')).toBe(true), { timeout: 8_000 })
}

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

const taskEvents = (taskId: string): Array<Extract<ChatEvent, { kind: 'task' }>> =>
  events.filter((event): event is Extract<ChatEvent, { kind: 'task' }> => event.kind === 'task' && event.task.id === taskId)

describe('Stop on a turn', () => {
  it('leaves a dev server from an earlier turn running, and the window still hears when the user stops it', async () => {
    const chat = chatService()
    script = [[runCommand('serve', { command: SERVER, background: true, yield_ms: 5_000 }), useTools], [{ type: 'text_delta', text: 'The server is up.' }]]
    await chat.start(request('turn-1'))
    await finished('turn-1')
    const [server] = chat.processManager.list('task') as [BackgroundTask]
    expect(server).toMatchObject({ status: 'running', conversationId: 'task' })
    expect(server.readyHint?.port).toBe(4010)

    // A later turn is waiting on a command when the user presses Stop.
    script = [[runCommand('wait', { command: SLEEPER, timeout_ms: 60_000 }), useTools]]
    await chat.start(request('turn-2'))
    await commandInFlight('turn-2', 'wait')
    chat.cancel('turn-2')
    await finished('turn-2')

    expect(chat.processManager.get(server.id)?.status).toBe('running')
    expect(alive(server.pid)).toBe(true)
    // The command that turn was waiting on did end.
    const waited = events.find((event) => event.streamId === 'turn-2' && event.kind === 'tool' && event.tool.id === 'wait' && event.tool.phase !== 'running')
    expect(waited).toMatchObject({ kind: 'tool', tool: { phase: 'error', detail: expect.stringContaining('cancelled') } })

    // The user ends it from the Tasks tab, with no turn running: the window must still be told.
    await chat.processManager.stop(server.id)
    await vi.waitFor(() => expect(taskEvents(server.id).at(-1)?.task.endedAt).toBeDefined())
    const last = taskEvents(server.id).at(-1)!
    expect(last).toMatchObject({ streamId: 'turn-1', conversationId: 'task', task: { status: 'killed' } })
    const turnOneEnded = events.findIndex((event) => event.streamId === 'turn-1' && event.kind === 'stream' && event.event.type === 'completed')
    expect(events.lastIndexOf(last)).toBeGreaterThan(turnOneEnded)
    await vi.waitFor(() => expect(alive(server.pid)).toBe(false))
  })

  it('ends the background tasks the stopped turn itself started', async () => {
    const chat = chatService()
    script = [[
      runCommand('own-server', { command: SERVER, background: true, yield_ms: 5_000 }),
      runCommand('wait', { command: SLEEPER, timeout_ms: 60_000 }),
      useTools
    ]]
    await chat.start(request('turn-a'))
    await commandInFlight('turn-a', 'wait')
    const [own] = chat.processManager.list('task') as [BackgroundTask]
    expect(own.status).toBe('running')

    chat.cancel('turn-a')
    await finished('turn-a')

    await vi.waitFor(() => expect(chat.processManager.get(own.id)?.status).toBe('killed'))
    await vi.waitFor(() => expect(alive(own.pid)).toBe(false))
  })

  it('ends only the stopped turn\'s tasks when two turns each started one', async () => {
    const chat = chatService()
    script = [[runCommand('first', { command: SERVER, background: true, yield_ms: 5_000 }), useTools], [{ type: 'text_delta', text: 'Up.' }]]
    await chat.start(request('turn-1'))
    await finished('turn-1')

    script = [[runCommand('second', { command: SLEEPER, background: true, yield_ms: 250 }), runCommand('wait', { command: SLEEPER, timeout_ms: 60_000 }), useTools]]
    await chat.start(request('turn-2'))
    await commandInFlight('turn-2', 'wait')
    chat.cancel('turn-2')
    await finished('turn-2')

    const tasks = chat.processManager.list('task')
    expect(tasks).toHaveLength(2)
    const byCommand = (command: string): BackgroundTask => tasks.find((task) => task.command === command)!
    expect(byCommand(SERVER).status).toBe('running')
    await vi.waitFor(() => expect(chat.processManager.get(byCommand(SLEEPER).id)?.status).toBe('killed'))
  })

  it('ends every task of a conversation when the conversation is deleted', async () => {
    const chat = chatService()
    script = [[runCommand('serve', { command: SERVER, background: true, yield_ms: 5_000 }), useTools], [{ type: 'text_delta', text: 'Up.' }]]
    await chat.start(request('turn-1'))
    await finished('turn-1')
    const [server] = chat.processManager.list('task') as [BackgroundTask]

    chat.forgetConversation('task')

    expect(chat.processManager.list('task')).toEqual([])
    await vi.waitFor(() => expect(alive(server.pid)).toBe(false))
  })
})

describe('the shell the user chose', () => {
  it.skipIf(process.platform !== 'win32')('runs the next turn\'s commands in it and tells the model which one it is', async () => {
    const chat = chatService()
    mocks.shell = 'cmd'
    script = [[runCommand('ver', { command: 'ver' }), useTools], [{ type: 'text_delta', text: 'ok' }]]
    await chat.start(request('turn-cmd'))
    await finished('turn-cmd')
    expect(String(requests[0]?.system)).toContain('Windows command shell (cmd.exe)')
    expect(JSON.stringify(requests[1]?.messages)).toContain('Microsoft Windows')

    // Changed between turns: it applies from the next turn, in the prompt and in the shell itself.
    mocks.shell = 'powershell'
    script = [[runCommand('version', { command: '$PSVersionTable.PSVersion.Major' }), useTools], [{ type: 'text_delta', text: 'ok' }]]
    await chat.start(request('turn-powershell'))
    await finished('turn-powershell')
    expect(String(requests[2]?.system)).toContain('Windows PowerShell 5.1')
    expect(String(requests[2]?.system)).not.toContain('Windows command shell')
    expect(JSON.stringify(requests[3]?.messages)).toMatch(/Exit code: 0\\n\\n\d/)
  })
})
