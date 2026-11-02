import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_RETRY_POLICY } from '@core/types'
import type { AIMessage, AIProvider, AIRequest, AIResponse, AIStreamEvent, ToolCall } from '@core/types'
import type { ChatEvent, ChatStartRequest } from '@shared/ipc'
import type { ProviderManager } from './ProviderManager'
import { removeFolder } from './testing/removeFolder'

const mocks = vi.hoisted(() => ({
  dataRoot: '',
  workspace: '',
  usage: [] as unknown[],
  ran: [] as string[],
  /** What the stand-in run_command returns for a command. */
  shell: ((_command: string) => ({ content: 'Exit code: 0\n\nok', isError: false })) as (command: string) => { content: string; isError: boolean },
  reviewer: undefined as undefined | { enabled: boolean; providerId: string; model: string }
}))
vi.mock('./paths', () => ({ dataDir: () => mocks.dataRoot }))
vi.mock('./db', () => ({ conversationRepo: { get: (id: string) => ({ id, workspacePath: mocks.workspace, messages: [] }) } }))
vi.mock('./config', () => ({
  getSettings: () => ({
    general: { workspacePath: mocks.workspace }, mcpServers: [], hooks: [], privacy: { localOnly: false }, shell: { preferred: 'auto' },
    ai: { ...(mocks.reviewer ? { reviewer: mocks.reviewer } : {}) }
  })
}))
vi.mock('./cost', () => ({ recordUsage: (usage: unknown) => { mocks.usage.push(usage) } }))
vi.mock('./logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))
// A real shell would make these tests slow and dependent on npm: the stand-in answers like one.
vi.mock('./tools/shellTool', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./tools/shellTool')>()),
  createShellTool: () => ({
    definition: {
      name: 'run_command', description: 'Run a command.',
      inputSchema: { type: 'object', properties: { command: { type: 'string' }, background: { type: 'boolean' } }, required: ['command'] }
    },
    defaultPermission: 'ask',
    async execute(input: { command: string }) {
      mocks.ran.push(input.command)
      return { toolUseId: '', ...mocks.shell(input.command) }
    }
  })
}))

import { ChatService } from './ChatService'

let root: string
let services: ChatService[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cubex-harness-chat-'))
  mocks.dataRoot = join(root, 'data')
  mocks.workspace = join(root, 'workspace')
  mocks.usage = []
  mocks.ran = []
  mocks.reviewer = undefined
  mocks.shell = () => ({ content: 'Exit code: 0\n\nok', isError: false })
  for (const dir of [mocks.dataRoot, mocks.workspace, join(mocks.workspace, 'src')]) mkdirSync(dir)
  writeFileSync(join(mocks.workspace, 'notes.txt'), 'hello')
  writeFileSync(join(mocks.workspace, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'vitest run' } }))
  writeFileSync(join(mocks.workspace, 'src', 'index.ts'), 'export function main(): number {\n  return 1\n}\n')
})
afterEach(async () => {
  for (const service of services) { service.cancelAll(); service.dispose() }
  services = []
  await removeFolder(root)
})

const policy = { primary: { providerId: 'p', model: 'm' }, fallbacks: [], fallbackEnabled: false, retry: { ...DEFAULT_RETRY_POLICY, enabled: false }, timeout: {} }
type Step = ToolCall[] | string

const call = (name: string, input: unknown, id = 'k1'): ToolCall => ({ id, name, input } as ToolCall)
const write = (path: string, id = 'w1'): ToolCall => call('write_file', { path, content: `export const value = '${id}'\n` }, id)
const check = (id = 'c1'): ToolCall => call('run_command', { command: 'npm test' }, id)

function harness(reviewerReplies: string[] = []) {
  const events: ChatEvent[] = []
  const requests: AIRequest[] = []
  const reviews: AIRequest[] = []
  let steps: Step[] = []
  let used = 0
  let turns = 0
  const provider = {
    id: 'p', name: 'Provider',
    async *streamMessage(request: AIRequest): AsyncGenerator<AIStreamEvent> {
      requests.push(structuredClone(request))
      const step = steps[used++] ?? 'Done.'
      if (typeof step === 'string') yield { type: 'text_delta', text: step }
      else for (const toolCall of step) yield { type: 'tool_call', toolCall }
    }
  } as unknown as AIProvider
  const reviewerProvider = {
    id: 'rev', name: 'Reviewer',
    async sendMessage(request: AIRequest): Promise<AIResponse> {
      reviews.push(structuredClone(request))
      const text = reviewerReplies[reviews.length - 1] ?? '{"verdict":"approve","feedback":""}'
      return { id: 'r', provider: 'rev', model: 'rev-1', content: [], text, toolCalls: [], stopReason: 'stop', createdAt: 0, usage: { inputTokens: 500, outputTokens: 30, totalTokens: 530 } } as unknown as AIResponse
    }
  } as unknown as AIProvider
  const service = new ChatService({
    resolve: (id: string) => (id === 'rev' ? reviewerProvider : provider),
    getModelInfo: () => undefined
  } as unknown as ProviderManager, (event) => { events.push(event) })
  services.push(service)
  return {
    service, requests, reviews, events,
    async turn(turnSteps: Step[], options: { userText?: string; conversationId?: string } = {}) {
      steps = turnSteps; used = 0
      const from = events.length
      const request: ChatStartRequest = {
        streamId: `s${++turns}`, conversationId: options.conversationId ?? 'c1', messageId: `u${turns}`, userText: options.userText ?? 'Add the value.',
        fileToolsEnabled: true, permissionMode: 'bypass', policy
      }
      await service.start(request)
      await vi.waitFor(() => expect(events.slice(from).some((e) => e.kind === 'stream' && (e.event.type === 'completed' || e.event.type === 'error'))).toBe(true), { timeout: 10_000 })
      await new Promise((resolve) => setTimeout(resolve, 50))
      return events.slice(from)
    }
  }
}

const completedText = (events: ChatEvent[]): string => {
  const done = events.find((e) => e.kind === 'stream' && e.event.type === 'completed')
  return done && done.kind === 'stream' && done.event.type === 'completed' ? done.event.response.text : ''
}
const textOf = (message: AIMessage | undefined): string =>
  (message?.content ?? []).map((part) => (part.type === 'text' ? part.text : part.type === 'tool_result' ? JSON.stringify(part.content) : '')).join('\n')
const lastUser = (request: AIRequest | undefined): string => textOf([...(request?.messages ?? [])].reverse().find((m) => m.role === 'user'))
const toolResults = (request: AIRequest | undefined): Array<{ isError?: boolean; text: string }> =>
  (request?.messages ?? []).flatMap((m) => m.content.flatMap((part) => (part.type === 'tool_result' ? [{ isError: part.isError, text: JSON.stringify(part.content) }] : [])))
const toolCards = (events: ChatEvent[], name: string) => events.flatMap((e) => (e.kind === 'tool' && e.tool.name === name ? [e.tool] : []))

describe('mending a tool call', () => {
  it('runs a misnamed call with a number sent as a string, and records the call as it ran', async () => {
    const h = harness()
    await h.turn([[call('Read-File', '{"path":"notes.txt","limit":"1"}')], 'Read it.'])
    expect(h.requests).toHaveLength(2)
    const sent = h.requests[1]!.messages
    const used = sent.flatMap((m) => m.content).find((part) => part.type === 'tool_use')
    expect(used).toMatchObject({ type: 'tool_use', id: 'k1', name: 'read_file', input: { path: 'notes.txt', limit: 1 } })
    const [result] = toolResults(h.requests[1])
    expect(result!.isError).toBeUndefined()
    expect(result!.text).toContain('hello')
  })

  it('answers a call it cannot mend with what was wrong, and runs nothing', async () => {
    const h = harness()
    const events = await h.turn([[call('frobnicate', {}, 'k1'), call('read_file', { path: { nested: true } }, 'k2')], 'Could not.'])
    const [unknown, badType] = toolResults(h.requests[1])
    expect(unknown).toMatchObject({ isError: true })
    expect(unknown!.text).toContain('There is no tool named \\"frobnicate\\"')
    expect(unknown!.text).toContain('read_file')
    expect(badType).toMatchObject({ isError: true })
    expect(badType!.text).toContain('read_file')
    expect(badType!.text).toContain('path')
    expect(toolCards(events, 'read_file').at(-1)).toMatchObject({ phase: 'error' })
  })
})

describe('the done check', () => {
  it('asks once for a check after edits, then ends the turn saying the changes were not checked', async () => {
    const h = harness()
    const events = await h.turn([[write('src/a.ts')], 'Done.', 'Done anyway.'])
    expect(h.requests).toHaveLength(3)
    const nudge = lastUser(h.requests[2])
    expect(nudge).toContain('You changed src/a.ts and have not run a check since.')
    expect(nudge).toContain('`npm test`')
    expect(mocks.ran).toEqual([])
    expect(completedText(events)).toContain('These changes were not checked.')
  })

  it('is satisfied by a passing check, which is then remembered for the project', async () => {
    const h = harness()
    const events = await h.turn([[write('src/a.ts')], [check()], 'All done.'])
    expect(h.requests).toHaveLength(3)
    expect(JSON.stringify(h.requests[2]!.messages)).not.toContain('have not run a check')
    expect(mocks.ran).toEqual(['npm test'])
    expect(completedText(events)).not.toContain('not checked')
    h.service.dispose()
    const saved = JSON.parse(readFileSync(join(mocks.dataRoot, 'project-commands.json'), 'utf8')) as { projects: Record<string, { commands: string[] }> }
    expect(Object.values(saved.projects).map((entry) => entry.commands)).toEqual([['npm test']])
  })

  it('does not nag after a check that ran and failed, and does not remember it', async () => {
    mocks.shell = () => ({ content: 'Exit code: 1\n\n1 failed', isError: true })
    const h = harness()
    const events = await h.turn([[write('src/a.ts')], [check()], 'The test fails because of the fixture.'])
    expect(h.requests).toHaveLength(3)
    expect(completedText(events)).not.toContain('not checked')
    h.service.dispose()
    expect(existsSync(join(mocks.dataRoot, 'project-commands.json'))).toBe(false)
  })

  it('sends the agent back once when it ends with an empty reply after tool work', async () => {
    const h = harness()
    const events = await h.turn([[call('read_file', { path: 'notes.txt' })], '', '', 'It says hello.'])
    expect(h.requests).toHaveLength(3)
    expect(lastUser(h.requests[2])).toContain('Your last reply was empty.')
    expect(completedText(events)).toBe('')
  })

  it('leaves documentation edits, a person who said not to run anything, and a cut-off call alone', async () => {
    const h = harness()
    await h.turn([[call('write_file', { path: 'README.md', content: '# Fixture\n' })], 'Wrote it.'])
    expect(h.requests).toHaveLength(2)

    const quiet = harness()
    await quiet.turn([[write('src/a.ts')], 'Done.'], { userText: 'Add the value. Do not run anything.' })
    expect(quiet.requests).toHaveLength(2)

    const failed = harness()
    await failed.turn([[call('write_file', { path: 'src/b.ts' })], 'It could not be written.'])
    expect(failed.requests).toHaveLength(2)
  })
})

describe('the reviewer', () => {
  beforeEach(() => { mocks.reviewer = { enabled: true, providerId: 'rev', model: 'rev-1' } })

  it('sends its fixes to the model as a message from the reviewer, and is asked once per turn', async () => {
    const h = harness(['{"verdict":"revise","feedback":"1. src/a.ts: handle an empty value."}'])
    const events = await h.turn([[write('src/a.ts')], [check()], 'Implemented.', [write('src/b.ts', 'w2')], [check('c2')], 'Fixed.'], { userText: 'Add the value to src/a.ts.' })
    expect(h.reviews).toHaveLength(1)
    const review = textOf(h.reviews[0]!.messages[0])
    expect(review).toContain('Add the value to src/a.ts.')
    expect(review).toContain("+export const value = 'w1'")
    expect(review).toContain('npm test (passed)')
    expect(h.reviews[0]!.model).toBe('rev-1')
    // The model reads the fixes, saying whose they are; the turn then ends without a second review.
    const note = lastUser(h.requests[3])
    expect(note).toContain("reviewer's note, not a message from the user")
    expect(note).toContain('1. src/a.ts: handle an empty value.')
    expect(h.requests).toHaveLength(6)
    const cards = toolCards(events, 'review_turn')
    expect(cards.map((card) => [card.phase, card.title, card.detail])).toEqual([['running', 'Review', undefined], ['done', 'Review', 'Sent fixes']])
    // The reviewer's request is billed to the reviewer's model.
    expect(mocks.usage).toContainEqual(expect.objectContaining({ providerId: 'rev', modelId: 'rev-1' }))
  })

  it('approves quietly, and skips a turn that changed no files', async () => {
    const h = harness()
    const events = await h.turn([[write('src/a.ts')], [check()], 'Implemented.'])
    expect(h.reviews).toHaveLength(1)
    expect(h.requests).toHaveLength(3)
    expect(toolCards(events, 'review_turn').at(-1)).toMatchObject({ phase: 'done', title: 'Review', detail: 'Approved' })

    const idle = harness()
    await idle.turn([[call('read_file', { path: 'notes.txt' })], 'Looked.'])
    expect(idle.reviews).toHaveLength(0)
  })

  it('does not hold the turn when the reviewer fails', async () => {
    const h = harness(['I could not read the diff.'])
    await h.turn([[write('src/a.ts')], [check()], 'Implemented.'])
    expect(h.reviews).toHaveLength(1)
    expect(h.requests).toHaveLength(3)
  })
})

describe('the project map and commands in the prompt', () => {
  it('puts both in the prompt and keeps the prompt identical on later turns, until the folder changes', async () => {
    const h = harness()
    await h.turn(['Hello.'])
    const first = String(h.requests[0]!.system)
    expect(first).toContain('## Project map')
    expect(first).toContain('src/index.ts')
    expect(first).toContain('## Project commands')
    expect(first).toContain('- npm test (test)')

    // Files that appear later, and a check that passes, change nothing in the prompt of this task.
    writeFileSync(join(mocks.workspace, 'src', 'later.ts'), 'export function later(): void {}\n')
    mocks.shell = () => ({ content: 'Exit code: 0\n\nok', isError: false })
    await h.turn([[check()], 'Checked.'])
    expect(String(h.requests[1]!.system)).toBe(first)
    await h.turn(['Hello again.'])
    expect(String(h.requests[3]!.system)).toBe(first)

    // A different folder gets its own map.
    const other = join(root, 'other')
    mkdirSync(other)
    writeFileSync(join(other, 'tool.py'), 'def run():\n    pass\n')
    mocks.workspace = other
    await h.turn(['In the other folder.'])
    const moved = String(h.requests[4]!.system)
    expect(moved).toContain('tool.py')
    expect(moved).not.toContain('src/index.ts')
  })

  it('leaves them out of a task that may not read files', async () => {
    const h = harness()
    await h.service.start({ streamId: 'nofiles', conversationId: 'c2', messageId: 'u9', userText: 'Hi', fileToolsEnabled: false, subagentEnabled: false, permissionMode: 'default', policy })
    await vi.waitFor(() => expect(h.requests.length).toBe(1))
    expect(String(h.requests[0]!.system ?? '')).not.toContain('## Project map')
    expect(String(h.requests[0]!.system ?? '')).not.toContain('## Project commands')
  })
})
