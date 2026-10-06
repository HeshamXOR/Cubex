import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_RETRY_POLICY } from '@core/types'
import type { AIProvider, AIRequest, AIStreamEvent } from '@core/types'
import type { ChatEvent, ChatStartRequest, StoredMessage, ToolActivity } from '@shared/ipc'
import type { ProviderManager } from './ProviderManager'

const mocks = vi.hoisted(() => ({
  dataRoot: '', selectedWorkspace: '',
  conversations: {} as Record<string, { id: string; workspacePath?: string; messages: StoredMessage[] }>
}))
vi.mock('./paths', () => ({ dataDir: () => mocks.dataRoot }))
vi.mock('./db', () => ({ conversationRepo: { get: (id: string) => mocks.conversations[id] } }))
vi.mock('./config', () => ({ getSettings: () => ({ general: { workspacePath: mocks.selectedWorkspace }, mcpServers: [], hooks: [] }) }))
vi.mock('./cost', () => ({ recordUsage: vi.fn() }))
vi.mock('./logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))

import { ChatService } from './ChatService'
import { CommandOutputStore } from './commandOutput'

let service: ChatService | undefined
beforeEach(() => {
  mocks.dataRoot = mkdtempSync(join(tmpdir(), 'cubex-output-chat-'))
  const workspace = join(mocks.dataRoot, 'task-workspace')
  mocks.selectedWorkspace = join(mocks.dataRoot, 'foreign-workspace')
  mkdirSync(workspace)
  mkdirSync(mocks.selectedWorkspace)
  mocks.conversations = {
    task: { id: 'task', workspacePath: workspace, messages: [] },
    foreign: { id: 'foreign', workspacePath: mocks.selectedWorkspace, messages: [] }
  }
})
afterEach(() => {
  service?.cancelAll()
  service?.dispose()
  service = undefined
  rmSync(mocks.dataRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function request(streamId = 'stream-one'): ChatStartRequest {
  return {
    streamId, conversationId: 'task', userText: 'Run the requested command', fileToolsEnabled: true, permissionMode: 'bypass',
    policy: { primary: { providerId: 'primary', model: 'test' }, fallbacks: [], fallbackEnabled: false, retry: { ...DEFAULT_RETRY_POLICY, enabled: false }, timeout: {} }
  }
}

function startService(stream: (request: AIRequest) => AsyncGenerator<AIStreamEvent>, events: ChatEvent[]): ChatService {
  const provider = { id: 'primary', streamMessage: stream } as unknown as AIProvider
  const manager = { resolve: (id: string) => id === 'primary' ? provider : undefined, getModelInfo: () => undefined } as unknown as ProviderManager
  service = new ChatService(manager, (event) => { events.push(event) })
  return service
}

async function finished(events: ChatEvent[], streamId = 'stream-one'): Promise<void> {
  await vi.waitFor(() => expect(events.some((event) => event.streamId === streamId && event.kind === 'stream' && event.event.type === 'completed')).toBe(true), { timeout: 5_000 })
}

function terminalTools(events: ChatEvent[], streamId?: string): ToolActivity[] {
  return events.filter((event) => event.kind === 'tool' && event.tool.phase !== 'running' && (!streamId || event.streamId === streamId))
    .map((event) => event.kind === 'tool' ? event.tool : undefined).filter((tool): tool is ToolActivity => !!tool)
}

function seed(conversationId: string, text: string, command = 'earlier command') {
  const store = new CommandOutputStore(join(mocks.dataRoot, 'command-output'))
  const writer = store.create(conversationId, { command })
  writer.append(text)
  const artifact = writer.finish({ status: 'completed', exitCode: 0 })
  return { artifact, path: store.revealPath(conversationId, writer.id) }
}

describe('ChatService saved command output', () => {
  it.each([0, 7])('emits task-owned output metadata after a real command, including exit %i', async (exitCode) => {
    const events: ChatEvent[] = []
    const requests: AIRequest[] = []
    const foreign = seed('foreign', 'foreign secret', 'foreign-only-command')
    const chat = startService(async function* (req): AsyncGenerator<AIStreamEvent> {
      requests.push(structuredClone(req))
      if (requests.length === 1) {
        yield { type: 'tool_call', toolCall: {
          id: 'shell-call', name: 'run_command',
          input: { command: `node -e "console.log('saved-command-output'); console.log(process.cwd()); console.log('Saved output: ${foreign.artifact.id}'); process.exitCode = ${exitCode}"` }
        } }
        yield { type: 'stop', stopReason: 'tool_use' }
      } else yield { type: 'text_delta', text: 'Done.' }
    }, events)
    await chat.start(request())
    await finished(events)
    const tool = terminalTools(events).find((item) => item.name === 'run_command')!
    expect(tool).toMatchObject({ id: 'shell-call', phase: exitCode ? 'error' : 'done', outputConversationId: 'task' })
    expect(tool.outputId).toMatch(/^[a-f0-9-]{36}$/)
    expect(tool.outputId).not.toBe(foreign.artifact.id)
    const page = chat.readCommandOutput('task', tool.outputId!)
    expect(page.text).toContain('saved-command-output')
    expect(page.text.toLowerCase()).toContain(mocks.conversations.task!.workspacePath!.toLowerCase())
    expect(page.text).not.toContain(mocks.selectedWorkspace)
    expect(page.artifact).toMatchObject({ id: tool.outputId, conversationId: 'task', status: exitCode ? 'failed' : 'completed', exitCode })
    expect(JSON.stringify(requests[1]?.messages)).toContain('Saved output:')
    expect(() => chat.readCommandOutput('foreign', tool.outputId!)).toThrow('unavailable')
  })

  it('offers an owned saved-output catalog and read tool on a later plan turn with file tools disabled', async () => {
    const events: ChatEvent[] = []
    const requests: AIRequest[] = []
    let outputId = ''
    const foreign = seed('foreign', 'secret elsewhere', 'foreign-catalog-marker')
    const chat = startService(async function* (req): AsyncGenerator<AIStreamEvent> {
      requests.push(structuredClone(req))
      if (requests.length === 1) {
        yield { type: 'tool_call', toolCall: { id: 'run-first', name: 'run_command', input: { command: 'echo saved-for-next-turn' } } }
        yield { type: 'stop', stopReason: 'tool_use' }
      } else if (requests.length === 3) {
        expect(req.tools?.some((tool) => tool.name === 'read_command_output')).toBe(true)
        expect(req.tools?.some((tool) => tool.name === 'run_command')).toBe(false)
        expect(String(req.system)).toContain('Saved command outputs')
        expect(String(req.system)).toContain(outputId)
        expect(String(req.system)).not.toContain(foreign.artifact.id)
        expect(String(req.system)).not.toContain('foreign-catalog-marker')
        yield { type: 'tool_call', toolCall: { id: 'read-later', name: 'read_command_output', input: { output_id: outputId } } }
        yield { type: 'stop', stopReason: 'tool_use' }
      } else yield { type: 'text_delta', text: 'Done.' }
    }, events)
    await chat.start(request())
    await finished(events)
    outputId = terminalTools(events).find((tool) => tool.name === 'run_command')!.outputId!
    await chat.start({ ...request('stream-two'), userText: 'Read the earlier output', fileToolsEnabled: false, permissionMode: 'plan' })
    await finished(events, 'stream-two')
    expect(terminalTools(events, 'stream-two')).toContainEqual(expect.objectContaining({ name: 'read_command_output', phase: 'done' }))
    expect(events.some((event) => event.streamId === 'stream-two' && event.kind === 'permission')).toBe(false)
    expect(JSON.stringify(requests[3]!.messages)).toContain('saved-for-next-turn')
    expect(JSON.stringify(requests[3]!.messages)).not.toContain('secret elsewhere')
  })

  it('denies missing tasks, missing/foreign outputs and filesystem paths through both service APIs', () => {
    const own = seed('task', 'owned output')
    const chat = startService(async function* () { yield { type: 'text_delta', text: 'Done.' } }, [])
    expect(chat.commandOutputPath('task', own.artifact.id)).toBe(own.path)
    expect(() => chat.readCommandOutput('missing-task', own.artifact.id)).toThrow('Task was not found')
    expect(() => chat.commandOutputPath('missing-task', own.artifact.id)).toThrow('Task was not found')
    expect(() => chat.readCommandOutput('foreign', own.artifact.id)).toThrow('unavailable')
    expect(() => chat.commandOutputPath('foreign', own.artifact.id)).toThrow('No matching')
    expect(() => chat.readCommandOutput('task', randomUUID())).toThrow('unavailable')
    expect(() => chat.commandOutputPath('task', randomUUID())).toThrow('No matching')
    expect(() => chat.readCommandOutput('task', '../secret.txt')).toThrow('Invalid command output id')
    expect(() => chat.commandOutputPath('task', own.path)).toThrow('Invalid command output id')
  })

  it('starts future chats and saves new command output despite unrelated corrupt or missing older artifacts', async () => {
    const good = seed('task', 'healthy history')
    const corrupt = seed('task', 'corrupt receipt')
    const missing = seed('task', 'deleted log')
    writeFileSync(corrupt.path.replace(/\.log$/, '.json'), '{invalid json')
    unlinkSync(missing.path)
    const events: ChatEvent[] = []
    let calls = 0
    const chat = startService(async function* (req) {
      calls++
      if (calls === 1) {
        expect(String(req.system)).toContain(good.artifact.id)
        expect(String(req.system)).not.toContain(corrupt.artifact.id)
        expect(String(req.system)).not.toContain(missing.artifact.id)
        yield { type: 'tool_call', toolCall: { id: 'new-run', name: 'run_command', input: { command: 'echo fresh-output' } } }
        yield { type: 'stop', stopReason: 'tool_use' }
      } else yield { type: 'text_delta', text: 'Done.' }
    }, events)
    await chat.start(request())
    await finished(events)
    const tool = terminalTools(events).find((item) => item.name === 'run_command')!
    expect(tool.phase).toBe('done')
    expect(chat.readCommandOutput('task', tool.outputId!).text).toContain('fresh-output')
    expect(() => chat.readCommandOutput('task', corrupt.artifact.id)).toThrow()
    expect(() => chat.readCommandOutput('task', missing.artifact.id)).toThrow()
  })

  it('does not allocate a saved command artifact when plan mode blocks execution', async () => {
    const events: ChatEvent[] = []
    let calls = 0
    const chat = startService(async function* () {
      if (calls++ === 0) {
        yield { type: 'tool_call', toolCall: { id: 'blocked-run', name: 'run_command', input: { command: 'node -e "console.log(123)"' } } }
        yield { type: 'stop', stopReason: 'tool_use' }
      } else yield { type: 'text_delta', text: 'Research only.' }
    }, events)
    await chat.start({ ...request(), permissionMode: 'plan' })
    await finished(events)
    const tool = terminalTools(events).find((item) => item.name === 'run_command')!
    expect(tool).toMatchObject({ phase: 'error', detail: 'Blocked in plan mode' })
    expect(tool.outputId).toBeUndefined()
    expect(new CommandOutputStore(join(mocks.dataRoot, 'command-output')).list('task')).toEqual([])
  })
})
