import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_RETRY_POLICY } from '@core/types'
import type { AIProvider, AIRequest, AIStreamEvent, ExecutableTool, ToolCall } from '@core/types'
import type { ChatEvent, PermissionDecision, PermissionMode } from '@shared/ipc'
import type { ProviderManager } from './ProviderManager'

/**
 * Parallel read-only tools through the real agent loop. The file, shell, fetch and search tools are
 * replaced by fakes that record when each call starts and ends and can be held until the test lets
 * them go, so overlap, the cap of four and result order are observed rather than inferred from timing.
 */
const mocks = vi.hoisted(() => {
  const m = {
    dataRoot: '', workspace: '',
    /** Tool starts and ends, permission asks, plan reviews and tool events, in the order they happened. */
    timeline: [] as string[],
    /** `<tool>:<target>` of every call that began, in start order. */
    started: [] as string[],
    /** Calls in flight right now, and the most there ever were at once. */
    active: 0, peak: 0,
    /** How many calls were already in flight when each call began, by `<tool>:<target>`. */
    activeAtStart: new Map<string, number>(),
    /** What a call waits for before it finishes, by target. */
    hold: new Map<string, Promise<void>>(),
    /** Targets whose call throws. */
    failing: new Set<string>(),
    fakeTool: undefined as unknown as (name: string, permission: 'allow' | 'ask') => ExecutableTool
  }
  const targetOf = (input: unknown): string => {
    const fields = (input ?? {}) as Record<string, unknown>
    return String(fields.path ?? fields.pattern ?? fields.query ?? fields.url ?? fields.command ?? '')
  }
  m.fakeTool = (name, permission) => ({
    definition: { name, description: `fake ${name}`, inputSchema: { type: 'object' } },
    defaultPermission: permission,
    async execute(input) {
      const target = targetOf(input)
      const key = `${name}:${target}`
      m.timeline.push(`start ${key}`)
      m.started.push(key)
      m.activeAtStart.set(key, m.active)
      m.active++
      m.peak = Math.max(m.peak, m.active)
      try {
        await m.hold.get(target)
        if (m.failing.has(target)) throw new Error(`cannot use ${target}`)
        return { toolUseId: '', content: `${name} result for ${target}` }
      } finally {
        m.active--
        m.timeline.push(`end ${key}`)
      }
    }
  })
  return m
})
vi.mock('./paths', () => ({ dataDir: () => mocks.dataRoot }))
vi.mock('./db', () => ({
  conversationRepo: { get: (id: string) => ({ id, workspacePath: mocks.workspace, messages: [] }) }
}))
vi.mock('./config', () => ({ getSettings: () => ({ general: { workspacePath: mocks.workspace }, mcpServers: [], hooks: [] }) }))
vi.mock('./cost', () => ({ recordUsage: vi.fn() }))
vi.mock('./logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))
vi.mock('./tools/fileTools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools/fileTools')>()
  return {
    ...actual,
    createFileTools: () => [
      mocks.fakeTool('read_file', 'allow'), mocks.fakeTool('list_files', 'allow'), mocks.fakeTool('glob_files', 'allow'),
      mocks.fakeTool('search_files', 'allow'), mocks.fakeTool('write_file', 'ask'), mocks.fakeTool('edit_file', 'ask')
    ]
  }
})
vi.mock('./tools/shellTool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools/shellTool')>()
  return { ...actual, createShellTool: () => mocks.fakeTool('run_command', 'ask') }
})
vi.mock('./tools/webFetchTool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools/webFetchTool')>()
  return { ...actual, createWebFetchTool: () => mocks.fakeTool('web_fetch', 'allow') }
})
vi.mock('./tools/webSearchTool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools/webSearchTool')>()
  return { ...actual, createWebSearchTool: () => mocks.fakeTool('web_search', 'allow') }
})

import { ChatService } from './ChatService'

interface Gate { open(): void }

let root: string
let services: ChatService[] = []
let gates: Gate[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cubex-parallel-'))
  mocks.dataRoot = join(root, 'data')
  mocks.workspace = join(root, 'workspace')
  mocks.timeline = []
  mocks.started = []
  mocks.active = 0
  mocks.peak = 0
  mocks.activeAtStart.clear()
  mocks.hold.clear()
  mocks.failing.clear()
  for (const dir of [mocks.dataRoot, mocks.workspace]) mkdirSync(dir)
})
afterEach(() => {
  for (const gate of gates) gate.open() // never leave a held call behind a failed assertion
  gates = []
  for (const service of services) { service.cancelAll(); service.dispose() }
  services = []
  rmSync(root, { recursive: true, force: true })
})

/** Hold every call aimed at `target` until the returned gate opens. */
function gate(target: string): Gate {
  let open!: () => void
  const promise = new Promise<void>((resolve) => { open = resolve })
  const held = { open }
  gates.push(held)
  mocks.hold.set(target, promise)
  return held
}

const tick = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const inFlight = (count: number): Promise<void> => vi.waitFor(() => expect(mocks.active).toBe(count), { timeout: 4000 })
const startedCount = (count: number): Promise<void> => vi.waitFor(() => expect(mocks.started).toHaveLength(count), { timeout: 4000 })
const at = (label: string): number => {
  const index = mocks.timeline.indexOf(label)
  expect(index, `"${label}" should be in the timeline: ${mocks.timeline.join(' | ')}`).toBeGreaterThanOrEqual(0)
  return index
}
const asked = (): boolean => mocks.timeline.some((entry) => entry.startsWith('ask '))

const policy = { primary: { providerId: 'p', model: 'm' }, fallbacks: [], fallbackEnabled: false, retry: { ...DEFAULT_RETRY_POLICY, enabled: false }, timeout: {} }
type Step = ToolCall[] | string

function harness() {
  const events: ChatEvent[] = []
  const requests: AIRequest[] = []
  let script: Step[] = []
  let answers: PermissionDecision[] = []
  let turns = 0
  const provider = {
    id: 'p',
    async *streamMessage(request: AIRequest): AsyncGenerator<AIStreamEvent> {
      requests.push(structuredClone(request))
      const step = script[requests.length - 1] ?? 'done'
      if (typeof step === 'string') yield { type: 'text_delta', text: step }
      else for (const toolCall of step) yield { type: 'tool_call', toolCall }
    }
  } as unknown as AIProvider
  const service: ChatService = new ChatService({ resolve: () => provider, getModelInfo: () => undefined } as unknown as ProviderManager, (event) => {
    events.push(event)
    if (event.kind === 'tool') mocks.timeline.push(`event ${event.tool.id} ${event.tool.phase}`)
    if (event.kind === 'permission') {
      mocks.timeline.push(`ask ${event.ask.toolName}`)
      const decision = answers.shift() ?? 'deny'
      queueMicrotask(() => service.resolvePermission(event.ask.id, decision))
    }
    if (event.kind === 'plan') {
      mocks.timeline.push('plan review')
      queueMicrotask(() => service.resolvePlan(event.ask.id, 'acceptEdits'))
    }
  })
  services.push(service)
  return {
    service,
    requests,
    /** Start a turn against a scripted model. `done` waits for the turn to end and returns its events. */
    async begin(steps: Step[], mode: PermissionMode = 'bypass', turnAnswers: PermissionDecision[] = []) {
      script = steps
      answers = [...turnAnswers]
      const from = events.length
      const streamId = `s${++turns}`
      await service.start({
        streamId, conversationId: 'c1', messageId: `u${turns}`, userText: 'go', fileToolsEnabled: true, permissionMode: mode, policy
      })
      return {
        streamId,
        done: async (): Promise<ChatEvent[]> => {
          await vi.waitFor(() => expect(events.slice(from).some((e) => e.kind === 'stream' && (e.event.type === 'completed' || e.event.type === 'error'))).toBe(true), { timeout: 8000 })
          return events.slice(from)
        }
      }
    }
  }
}

/** The tool results the model was sent for its first batch of calls, in the order they sit in the history. */
function resultsSentBack(requests: AIRequest[]): Array<{ id: string; text: string; error: boolean }> {
  const message = requests[1]?.messages.at(-1)
  expect(message?.role, 'the model should be asked again with the tool results').toBe('tool')
  return (message?.content ?? []).flatMap((part) => part.type === 'tool_result'
    ? [{ id: part.toolUseId, text: part.content.map((piece) => (piece.type === 'text' ? piece.text : '')).join(''), error: !!part.isError }]
    : [])
}

const phases = (events: ChatEvent[], id: string): string[] => events.flatMap((e) => (e.kind === 'tool' && e.tool.id === id ? [e.tool.phase] : []))
const call = (id: string, name: string, input: Record<string, unknown>): ToolCall => ({ id, name, input: input as ToolCall['input'] })
const read = (id: string, path: string): ToolCall => call(id, 'read_file', { path })
const listing = (id: string, path: string): ToolCall => call(id, 'list_files', { path })
const glob = (id: string, pattern: string): ToolCall => call(id, 'glob_files', { pattern })
const search = (id: string, query: string): ToolCall => call(id, 'search_files', { query })
const webSearch = (id: string, query: string): ToolCall => call(id, 'web_search', { query })
const fetchPage = (id: string, url: string): ToolCall => call(id, 'web_fetch', { url })
const write = (id: string, path: string): ToolCall => call(id, 'write_file', { path, content: 'text' })
const shell = (id: string, command: string): ToolCall => call(id, 'run_command', { command })

describe('parallel read-only tools', () => {
  it('runs read-only calls side by side and sends the results back in call order', async () => {
    const slow = gate('slow.txt')
    const quick = gate('quick.txt')
    const folder = gate('src')
    const pattern = gate('*.ts')
    const app = harness()
    const run = await app.begin([[read('r1', 'slow.txt'), read('r2', 'quick.txt'), listing('r3', 'src'), glob('r4', '*.ts')], 'done'])
    await inFlight(4) // all four are running at the same moment
    expect(mocks.peak).toBe(4)
    expect(mocks.started).toEqual(['read_file:slow.txt', 'read_file:quick.txt', 'list_files:src', 'glob_files:*.ts'])
    expect([...mocks.activeAtStart.values()]).toEqual([0, 1, 2, 3]) // each began while the earlier ones were still running
    // Finish them in the opposite order: a later call must never jump ahead of an earlier one in the history.
    for (const held of [pattern, folder, quick, slow]) { held.open(); await tick(5) }
    const events = await run.done()
    expect(mocks.timeline.filter((entry) => entry.startsWith('end '))).toEqual([
      'end glob_files:*.ts', 'end list_files:src', 'end read_file:quick.txt', 'end read_file:slow.txt'
    ])
    expect(resultsSentBack(app.requests)).toEqual([
      { id: 'r1', text: 'read_file result for slow.txt', error: false },
      { id: 'r2', text: 'read_file result for quick.txt', error: false },
      { id: 'r3', text: 'list_files result for src', error: false },
      { id: 'r4', text: 'glob_files result for *.ts', error: false }
    ])
    // Every call keeps its own running -> done events.
    for (const id of ['r1', 'r2', 'r3', 'r4']) expect(phases(events, id)).toEqual(['running', 'done'])
  })

  it('never runs more than four at once, and starts the next call as soon as one finishes', async () => {
    const held = Array.from({ length: 7 }, (_, index) => gate(`f${index}.txt`))
    const app = harness()
    const run = await app.begin([Array.from({ length: 7 }, (_, index) => read(`r${index}`, `f${index}.txt`)), 'done'])
    await inFlight(4)
    await tick(50)
    expect(mocks.started).toEqual(['f0', 'f1', 'f2', 'f3'].map((name) => `read_file:${name}.txt`)) // the rest wait their turn
    held[2]!.open() // a later call finishing frees a slot for the next in line
    await startedCount(5)
    expect(mocks.started[4]).toBe('read_file:f4.txt')
    held[0]!.open()
    held[1]!.open()
    await startedCount(7)
    for (const open of held) open.open()
    await run.done()
    expect(mocks.peak).toBe(4)
    expect(resultsSentBack(app.requests).map((result) => result.id)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6'])
  })

  it('runs a mutation alone, after the reads before it and before the reads after it', async () => {
    const a = gate('a.txt')
    const b = gate('b.txt')
    const out = gate('out.txt')
    const c = gate('c.txt')
    const d = gate('d.txt')
    const app = harness()
    const run = await app.begin([[read('r1', 'a.txt'), read('r2', 'b.txt'), write('w1', 'out.txt'), read('r3', 'c.txt'), read('r4', 'd.txt')], 'done'])
    await inFlight(2)
    await tick(50)
    expect(mocks.started).toEqual(['read_file:a.txt', 'read_file:b.txt']) // the write waits for both reads
    a.open()
    await tick(50)
    expect(mocks.started).toHaveLength(2) // one read is still running, so it still waits
    b.open()
    await vi.waitFor(() => expect(mocks.started).toContain('write_file:out.txt'), { timeout: 4000 })
    expect(mocks.activeAtStart.get('write_file:out.txt')).toBe(0) // it ran alone
    await tick(50)
    expect(mocks.started).toHaveLength(3) // the reads after it wait for it
    out.open()
    await startedCount(5)
    await inFlight(2) // and then overlap with each other again
    expect(mocks.activeAtStart.get('read_file:d.txt')).toBe(1)
    c.open()
    d.open()
    await run.done()
    expect(resultsSentBack(app.requests).map((result) => result.id)).toEqual(['r1', 'r2', 'w1', 'r3', 'r4'])
    expect(at('end write_file:out.txt')).toBeLessThan(at('start read_file:c.txt'))
  })

  it('asks for approval only once the reads before the prompt have finished', async () => {
    const a = gate('a.txt')
    const app = harness()
    const run = await app.begin([[read('r1', 'a.txt'), write('w1', 'out.txt'), read('r2', 'b.txt')], 'done'], 'default', ['allow'])
    await inFlight(1)
    await tick(50)
    expect(asked()).toBe(false) // the prompt must not appear while a read it depends on the order of is still running
    a.open()
    await run.done()
    expect(at('end read_file:a.txt')).toBeLessThan(at('ask write_file'))
    expect(at('end write_file:out.txt')).toBeLessThan(at('start read_file:b.txt'))
    expect(resultsSentBack(app.requests).map((result) => result.id)).toEqual(['r1', 'w1', 'r2'])
  })

  it('keeps going with the reads after a denied prompt, in order', async () => {
    const app = harness()
    const run = await app.begin([[read('r1', 'a.txt'), write('w1', 'out.txt'), read('r2', 'b.txt')], 'done'], 'default', ['deny'])
    const events = await run.done()
    expect(mocks.started).toEqual(['read_file:a.txt', 'read_file:b.txt']) // the denied write never ran
    expect(resultsSentBack(app.requests)).toEqual([
      { id: 'r1', text: 'read_file result for a.txt', error: false },
      { id: 'w1', text: 'Permission denied for "write_file".', error: true },
      { id: 'r2', text: 'read_file result for b.txt', error: false }
    ])
    expect(phases(events, 'w1')).toEqual(['running', 'error'])
  })

  it('overlaps a web fetch only when it would not ask, and treats a host approved earlier in the turn as free', async () => {
    const docs = gate('https://docs.python.org/3/')
    const query = gate('python docs')
    const a = gate('a.txt')
    const second = gate('https://example.org/b')
    const b = gate('b.txt')
    const app = harness()
    const run = await app.begin([[
      fetchPage('f1', 'https://docs.python.org/3/'), webSearch('s1', 'python docs'), read('r1', 'a.txt'),
      fetchPage('f2', 'https://example.org/a'), // unknown host: stops for approval
      fetchPage('f3', 'https://example.org/b'), // same host, approved moments ago: no prompt
      read('r2', 'b.txt')
    ], 'done'], 'default', ['allow'])
    await inFlight(3) // the pre-approved fetch, the search and the read overlap
    await tick(50)
    expect(asked()).toBe(false) // the prompt waits until all three are done
    for (const held of [docs, query, a]) held.open()
    await vi.waitFor(() => expect(mocks.started).toContain('read_file:b.txt'), { timeout: 4000 })
    expect(asked()).toBe(true)
    expect(mocks.timeline.filter((entry) => entry.startsWith('ask '))).toEqual(['ask web_fetch']) // one prompt, for the one new host
    expect(mocks.activeAtStart.get('web_fetch:https://example.org/a')).toBe(0) // the call that asked ran alone
    expect(mocks.activeAtStart.get('web_fetch:https://example.org/b')).toBe(0)
    expect(mocks.activeAtStart.get('read_file:b.txt')).toBe(1) // while the approved host's fetch and the read overlap
    second.open()
    b.open()
    await run.done()
    expect(resultsSentBack(app.requests).map((result) => result.id)).toEqual(['f1', 's1', 'r1', 'f2', 'f3', 'r2'])
  })

  it('keeps todo lists, plan reviews and shell commands in strict sequence with the reads around them', async () => {
    const a = gate('a.txt')
    const app = harness()
    const todo = call('t1', 'todo_write', { todos: [{ content: 'Check a.txt', status: 'in_progress' }] })
    const run = await app.begin([[read('r1', 'a.txt'), todo, shell('c1', 'npm test'), read('r2', 'b.txt')], 'done'])
    await inFlight(1)
    await tick(50)
    expect(mocks.timeline).not.toContain('event t1 running')
    a.open()
    await run.done()
    expect(at('end read_file:a.txt')).toBeLessThan(at('event t1 running'))
    expect(at('event t1 done')).toBeLessThan(at('start run_command:npm test'))
    expect(at('end run_command:npm test')).toBeLessThan(at('start read_file:b.txt'))
    expect(mocks.activeAtStart.get('run_command:npm test')).toBe(0)
    expect(resultsSentBack(app.requests).map((result) => result.id)).toEqual(['r1', 't1', 'c1', 'r2'])
  })

  it('waits for earlier reads before it pauses a plan for review', async () => {
    const a = gate('a.txt')
    const app = harness()
    const plan = call('p1', 'exit_plan_mode', { plan: '# Plan\n\n1. Fix the parser.' })
    const run = await app.begin([[read('r1', 'a.txt'), plan], 'done'], 'plan')
    await inFlight(1)
    await tick(50)
    expect(mocks.timeline).not.toContain('plan review')
    a.open()
    await run.done()
    expect(at('end read_file:a.txt')).toBeLessThan(at('plan review'))
    expect(resultsSentBack(app.requests).map((result) => result.id)).toEqual(['r1', 'p1'])
  })

  describe('with the turn guards', () => {
    it('keeps the repeat-call guard: an identical call never overlaps its twin, and the fourth is skipped', async () => {
      const a = gate('a.txt')
      const b = gate('b.txt')
      const app = harness()
      const calls = [read('r1', 'a.txt'), read('r2', 'b.txt'), read('r3', 'a.txt'), read('r4', 'a.txt'), read('r5', 'a.txt')]
      const run = await app.begin([calls, 'done'])
      await inFlight(2)
      await tick(50)
      expect(mocks.started).toEqual(['read_file:a.txt', 'read_file:b.txt']) // the repeats wait for the first instead of running beside it
      a.open()
      b.open()
      const events = await run.done()
      expect(mocks.started.filter((key) => key === 'read_file:a.txt')).toHaveLength(3)
      expect(mocks.peak).toBe(2)
      const sent = resultsSentBack(app.requests)
      expect(sent.map((result) => [result.id, result.error])).toEqual([['r1', false], ['r2', false], ['r3', false], ['r4', false], ['r5', true]])
      expect(sent[4]!.text).toContain('already made this exact "read_file" call 3 times')
      expect(phases(events, 'r5')).toEqual(['error'])
    })

    it('keeps the research cap across a batch, and counts calls in the order the model made them', async () => {
      const queries = Array.from({ length: 8 }, (_, index) => `query ${index + 1}`)
      const held = queries.slice(0, 6).map((query) => gate(query))
      const app = harness()
      const run = await app.begin([queries.map((query, index) => search(`q${index + 1}`, query)), 'done'])
      await inFlight(4)
      await tick(50)
      expect(mocks.started).toHaveLength(4)
      for (const open of held) open.open()
      const events = await run.done()
      expect(mocks.started).toEqual(queries.slice(0, 6).map((query) => `search_files:${query}`)) // the seventh and eighth never ran
      expect(mocks.peak).toBe(4)
      const sent = resultsSentBack(app.requests)
      expect(sent.map((result) => result.id)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8'])
      expect(sent.map((result) => result.error)).toEqual([false, false, false, false, false, false, true, true])
      expect(sent[6]!.text).toContain('Stop searching')
      expect(phases(events, 'q7')).toEqual(['error'])
    })

    it('reports a failing call on its own and lets an identical retry see the failure', async () => {
      mocks.failing.add('bad.txt')
      const ok = gate('ok.txt')
      const other = gate('other.txt')
      const app = harness()
      const run = await app.begin([[read('r1', 'ok.txt'), read('r2', 'bad.txt'), read('r3', 'other.txt'), read('r4', 'bad.txt')], 'done'])
      await vi.waitFor(() => expect(mocks.timeline).toContain('end read_file:bad.txt'), { timeout: 4000 })
      expect(mocks.active).toBe(2) // the failure did not stop the reads beside it
      ok.open()
      other.open()
      const events = await run.done()
      expect(mocks.started.filter((key) => key === 'read_file:bad.txt')).toHaveLength(1) // the retry was refused, not run
      const sent = resultsSentBack(app.requests)
      expect(sent.map((result) => [result.id, result.error])).toEqual([['r1', false], ['r2', true], ['r3', false], ['r4', true]])
      expect(sent[1]!.text).toContain('Tool error: cannot use bad.txt')
      expect(sent[3]!.text).toContain('This exact call already failed')
      expect(phases(events, 'r2')).toEqual(['running', 'error'])
      expect(phases(events, 'r4')).toEqual(['error'])
    })
  })

  it('stops starting queued calls once the turn is cancelled, and still ends the turn', async () => {
    const held = Array.from({ length: 6 }, (_, index) => gate(`f${index}.txt`))
    const app = harness()
    const run = await app.begin([Array.from({ length: 6 }, (_, index) => read(`r${index}`, `f${index}.txt`)), 'never requested'])
    await inFlight(4)
    app.service.cancel(run.streamId)
    for (const open of held) open.open()
    const events = await run.done()
    expect(mocks.started).toHaveLength(4) // the two queued calls never began
    expect(app.requests).toHaveLength(1) // and the model was not asked again
    expect(events.some((e) => e.kind === 'stream' && e.event.type === 'completed' && e.event.response.stopReason === 'cancelled')).toBe(true)
  })
})
