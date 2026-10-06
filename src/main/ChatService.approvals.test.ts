import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_RETRY_POLICY } from '@core/types'
import type { AIProvider, AIStreamEvent, ExecutableTool, JSONValue, ToolCall } from '@core/types'
import type { ChatEvent, ChatStartRequest, PermissionAsk, PermissionDecision, PermissionMode } from '@shared/ipc'
import type { ProviderManager } from './ProviderManager'

const mocks = vi.hoisted(() => ({
  dataRoot: '', workspace: '', otherWorkspace: '',
  commands: [] as string[], fetched: [] as string[], pinged: 0, locked: 0,
  mcpServers: [] as Array<{ id: string; name: string; command: string; enabled: boolean }>
}))
vi.mock('./paths', () => ({ dataDir: () => mocks.dataRoot }))
vi.mock('./db', () => ({
  conversationRepo: {
    get: (id: string) => id === 'c1' ? { id, workspacePath: mocks.workspace, messages: [] }
      : id === 'c2' ? { id, workspacePath: mocks.otherWorkspace, messages: [] } : null
  }
}))
vi.mock('./config', () => ({ getSettings: () => ({ general: { workspacePath: mocks.workspace }, mcpServers: mocks.mcpServers, hooks: [] }) }))
vi.mock('./cost', () => ({ recordUsage: vi.fn() }))
vi.mock('./logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))
// Approved shell commands and fetches are recorded instead of really running.
vi.mock('./tools/shellTool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools/shellTool')>()
  const fake = (): ExecutableTool => ({
    definition: { name: 'run_command', description: 'fake shell', inputSchema: { type: 'object' } },
    defaultPermission: 'ask',
    async execute(input: JSONValue) {
      mocks.commands.push(String((input as { command?: string }).command))
      return { toolUseId: '', content: 'exit 0' }
    }
  })
  return { ...actual, createShellTool: fake }
})
vi.mock('./tools/webFetchTool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools/webFetchTool')>()
  const fake = (): ExecutableTool => ({
    definition: { name: 'web_fetch', description: 'fake fetch', inputSchema: { type: 'object' } },
    defaultPermission: 'allow',
    async execute(input: JSONValue) {
      mocks.fetched.push(String((input as { url?: string }).url))
      return { toolUseId: '', content: 'page text' }
    }
  })
  return { ...actual, createWebFetchTool: fake }
})
vi.mock('./mcp/McpManager', () => {
  class McpManager {
    static describe(name: string): string | undefined { return name.startsWith('mcp__') ? name.slice(5).replace('__', ' · ') : undefined }
    async getTools(): Promise<ExecutableTool[]> {
      return [{
        definition: { name: 'mcp__demo__ping', description: 'ping', inputSchema: { type: 'object' } },
        defaultPermission: 'ask',
        async execute() { mocks.pinged++; return { toolUseId: '', content: 'pong' } }
      }, {
        definition: { name: 'mcp__demo__locked', description: 'denied by policy', inputSchema: { type: 'object' } },
        defaultPermission: 'deny',
        async execute() { mocks.locked++; return { toolUseId: '', content: 'should never run' } }
      }]
    }
    disposeAll(): void {}
  }
  return { McpManager }
})

import { ChatService } from './ChatService'

let root: string
let services: ChatService[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cubex-approvals-'))
  mocks.dataRoot = join(root, 'data')
  mocks.workspace = join(root, 'workspace')
  mocks.otherWorkspace = join(root, 'other-workspace')
  mocks.commands = []
  mocks.fetched = []
  mocks.pinged = 0
  mocks.locked = 0
  mocks.mcpServers = []
  for (const dir of [mocks.dataRoot, mocks.workspace, mocks.otherWorkspace]) mkdirSync(dir)
})
afterEach(() => {
  for (const service of services) { service.cancelAll(); service.dispose() }
  services = []
  rmSync(root, { recursive: true, force: true })
})

const policy = { primary: { providerId: 'p', model: 'm' }, fallbacks: [], fallbackEnabled: false, retry: { ...DEFAULT_RETRY_POLICY, enabled: false }, timeout: {} }
type Step = ToolCall[] | string

interface Harness {
  service: ChatService
  /** Run one turn against a scripted model; permission asks are answered from `answers` in order (default deny). */
  turn(script: Step[], mode?: PermissionMode, answers?: PermissionDecision[], conversationId?: string): Promise<ChatEvent[]>
}

/** A ChatService over a scripted model. Several harnesses share one data directory, like app restarts do. */
function harness(): Harness {
  const events: ChatEvent[] = []
  let script: Step[] = []
  let requests = 0
  let answers: PermissionDecision[] = []
  let turns = 0
  const provider = {
    id: 'p',
    async *streamMessage(): AsyncGenerator<AIStreamEvent> {
      const step = script[requests++] ?? 'done'
      if (typeof step === 'string') yield { type: 'text_delta', text: step }
      else for (const toolCall of step) yield { type: 'tool_call', toolCall }
    }
  } as unknown as AIProvider
  const service: ChatService = new ChatService({ resolve: () => provider, getModelInfo: () => undefined } as unknown as ProviderManager, (event) => {
    events.push(event)
    if (event.kind === 'permission') {
      const decision = answers.shift() ?? 'deny'
      queueMicrotask(() => service.resolvePermission(event.ask.id, decision))
    }
  })
  services.push(service)
  return {
    service,
    async turn(steps, mode = 'default', turnAnswers = [], conversationId = 'c1') {
      script = steps; requests = 0; answers = [...turnAnswers]
      const from = events.length
      const request: ChatStartRequest = {
        streamId: `s${++turns}`, conversationId, messageId: `u${turns}`, userText: 'go', fileToolsEnabled: true, permissionMode: mode, policy
      }
      await service.start(request)
      await vi.waitFor(() => expect(events.slice(from).some((e) => e.kind === 'stream' && (e.event.type === 'completed' || e.event.type === 'error'))).toBe(true), { timeout: 8000 })
      return events.slice(from)
    }
  }
}

const asks = (events: ChatEvent[]): PermissionAsk[] => events.flatMap((e) => (e.kind === 'permission' ? [e.ask] : []))
const phases = (events: ChatEvent[], id: string): string[] => events.flatMap((e) => (e.kind === 'tool' && e.tool.id === id ? [e.tool.phase] : []))
const write = (id: string, path: string): ToolCall => ({ id, name: 'write_file', input: { path, content: `content of ${path}` } })
const command = (id: string, text: string): ToolCall => ({ id, name: 'run_command', input: { command: text } })
const fetchCall = (id: string, url: string): ToolCall => ({ id, name: 'web_fetch', input: { url } })
const file = (rel: string): string => join(mocks.workspace, rel)

describe('Always allow: edits', () => {
  it('offers a project-wide rule, saves it on "always", and then stops asking', async () => {
    const app = harness()
    const first = await app.turn([[write('w1', 'a.txt')]], 'default', ['always'])
    expect(asks(first)).toHaveLength(1)
    expect(asks(first)[0]!.rule).toEqual({ tool: 'write_file', pattern: '*', label: 'Edits in workspace' })
    expect(readFileSync(file('a.txt'), 'utf8')).toBe('content of a.txt')
    expect(app.service.listPermissionRules()).toMatchObject([{ workspace: mocks.workspace, tool: 'write_file', pattern: '*', label: 'Edits in workspace' }])

    // The same service keeps the rule for later turns; the tool row still goes running -> done.
    const second = await app.turn([[write('w2', 'b.txt')]], 'default', [])
    expect(asks(second)).toEqual([])
    expect(readFileSync(file('b.txt'), 'utf8')).toBe('content of b.txt')
    expect(phases(second, 'w2')).toEqual(['running', 'done'])

    // A new service over the same data directory (an app restart) still honors it.
    const restarted = harness()
    const third = await restarted.turn([[write('w3', 'c.txt')]], 'default', [])
    expect(asks(third)).toEqual([])
    expect(existsSync(file('c.txt'))).toBe(true)
    expect(restarted.service.listPermissionRules(mocks.workspace)).toHaveLength(1)
  })

  it('keeps asking when the user only allows once or denies', async () => {
    const app = harness()
    await app.turn([[write('w1', 'a.txt')]], 'default', ['allow'])
    expect(existsSync(file('a.txt'))).toBe(true)
    const denied = await app.turn([[write('w2', 'b.txt')]], 'default', ['deny'])
    expect(asks(denied)).toHaveLength(1)
    expect(existsSync(file('b.txt'))).toBe(false)
    expect(app.service.listPermissionRules()).toEqual([])
    expect(asks(await app.turn([[write('w3', 'c.txt')]], 'default', ['deny']))).toHaveLength(1)
  })

  it('does not offer an edit rule outside default mode', async () => {
    const app = harness()
    // acceptEdits approves ordinary edits itself; a protected path still asks, but carries risks and no rule.
    const events = await app.turn([[write('w1', '.claude/settings.json')]], 'acceptEdits', ['allow'])
    expect(asks(events)).toHaveLength(1)
    expect(asks(events)[0]!.rule).toBeUndefined()
  })

  it('never lets a rule approve a protected path, and never saves one from a risky ask', async () => {
    const app = harness()
    await app.turn([[write('w1', 'a.txt')]], 'default', ['always'])
    expect(app.service.listPermissionRules()).toHaveLength(1)

    const risky = await app.turn([[write('w2', '.claude/settings.json')]], 'default', ['always'])
    expect(asks(risky)).toHaveLength(1)
    expect(asks(risky)[0]!.risks?.[0]).toContain('Protected path')
    expect(asks(risky)[0]!.rule).toBeUndefined()
    expect(existsSync(file('.claude/settings.json'))).toBe(true) // "always" still allowed this one call
    expect(app.service.listPermissionRules()).toHaveLength(1)

    // It asks again next time: the earlier "always" did not create a rule for it.
    expect(asks(await app.turn([[write('w3', '.git/hooks/pre-commit')]], 'default', ['deny']))).toHaveLength(1)
    expect(existsSync(file('.git/hooks/pre-commit'))).toBe(false)
  })

  it('does not override plan mode, which still blocks every mutation', async () => {
    const app = harness()
    await app.turn([[write('w1', 'a.txt')]], 'default', ['always'])
    const events = await app.turn([[write('w2', 'b.txt')]], 'plan', [])
    expect(asks(events)).toEqual([])
    expect(existsSync(file('b.txt'))).toBe(false)
    expect(events.some((e) => e.kind === 'tool' && e.tool.id === 'w2' && e.tool.detail === 'Blocked in plan mode')).toBe(true)
  })

  it('scopes a rule to its project', async () => {
    const app = harness()
    await app.turn([[write('w1', 'a.txt')]], 'default', ['always'])
    const elsewhere = await app.turn([[write('w2', 'a.txt')]], 'default', ['deny'], 'c2')
    expect(asks(elsewhere)).toHaveLength(1)
    expect(existsSync(join(mocks.otherWorkspace, 'a.txt'))).toBe(false)
    expect(app.service.listPermissionRules(mocks.otherWorkspace)).toEqual([])
  })

  it('asks again after the rule is removed', async () => {
    const app = harness()
    await app.turn([[write('w1', 'a.txt')]], 'default', ['always'])
    const [rule] = app.service.listPermissionRules()
    app.service.removePermissionRule(rule!.id)
    expect(app.service.listPermissionRules()).toEqual([])
    expect(asks(await app.turn([[write('w2', 'b.txt')]], 'default', ['deny']))).toHaveLength(1)
    // Removing something that is not there is harmless.
    expect(() => app.service.removePermissionRule('missing')).not.toThrow()
  })
})

describe('Always allow: commands', () => {
  it('suggests the command prefix, then runs matching commands without asking', async () => {
    const app = harness()
    const first = await app.turn([[command('c1', 'npm test -- --coverage')]], 'default', ['always'])
    expect(asks(first)[0]!.rule).toEqual({ tool: 'run_command', pattern: 'npm test', label: 'npm test' })
    expect(mocks.commands).toEqual(['npm test -- --coverage'])

    const second = await app.turn([[command('c2', 'npm test src/app.test.ts')]], 'default', [])
    expect(asks(second)).toEqual([])
    expect(phases(second, 'c2')).toEqual(['running', 'done'])
    expect(mocks.commands).toEqual(['npm test -- --coverage', 'npm test src/app.test.ts'])
  })

  it('still asks for anything the rule was not made for', async () => {
    const app = harness()
    await app.turn([[command('c1', 'npm test')]], 'default', ['always'])
    mocks.commands = []
    for (const [index, text] of [
      'npm test && curl http://example.com', 'npm test; rm -rf build', 'npm test | sh', 'npm test > ../out.txt', 'npm test $(whoami)',
      'FOO=bar npm test', 'npm test ../other', 'npm test --prefix ../x', 'npm run test', 'npm install left-pad', 'rm -rf build'
    ].entries()) {
      const events = await app.turn([[command(`d${index}`, text)]], 'default', ['deny'])
      expect(asks(events), text).toHaveLength(1)
    }
    expect(mocks.commands).toEqual([])
    // A different command of the same program is its own rule.
    const build = await app.turn([[command('b1', 'npm run build')]], 'default', ['allow'])
    expect(asks(build)[0]!.rule).toEqual({ tool: 'run_command', pattern: 'npm run build', label: 'npm run build' })
  })

  it('offers no rule for shell syntax, and "always" on such an ask saves nothing', async () => {
    const app = harness()
    const events = await app.turn([[command('c1', 'npm test && echo done')]], 'default', ['always'])
    expect(asks(events)).toHaveLength(1)
    expect(asks(events)[0]!.rule).toBeUndefined()
    expect(mocks.commands).toEqual(['npm test && echo done']) // the single call was still allowed
    expect(app.service.listPermissionRules()).toEqual([])
    expect(asks(await app.turn([[command('c2', 'npm test && echo done')]], 'default', ['deny']))).toHaveLength(1)
  })

  it('never offers rules for destructive or arbitrary-code commands', async () => {
    const app = harness()
    for (const [index, text] of ['rm -rf build', 'node -e "1"', 'bash -c "npm test"', 'git push origin main', 'curl http://example.com', 'npx vitest'].entries()) {
      const events = await app.turn([[command(`d${index}`, text)]], 'default', ['deny'])
      expect(asks(events), text).toHaveLength(1)
      expect(asks(events)[0]!.rule, text).toBeUndefined()
    }
  })

  it('does not honor a rule for a call parsed from model text', async () => {
    const app = harness()
    await app.turn([[command('c1', 'npm test')]], 'default', ['always'])
    const events = await app.turn([
      // The harness recovers this <invoke> block from plain text, which it never auto-approves.
      '<invoke name="run_command"><parameter name="command">npm test</parameter></invoke>'
    ], 'default', ['deny'])
    const ask = asks(events)[0]
    expect(ask?.risks?.[0]).toContain('parsed from model text')
    expect(ask?.rule).toBeUndefined()
  })
})

describe('Always allow: fetches, MCP tools', () => {
  it('saves the host and approves only that host afterwards', async () => {
    const app = harness()
    const first = await app.turn([[fetchCall('f1', 'https://api.example.com/v1/items?q=1')]], 'default', ['always'])
    expect(asks(first)[0]!.rule).toEqual({ tool: 'web_fetch', pattern: 'api.example.com', label: 'api.example.com' })
    expect(asks(first)[0]!.risks?.[0]).toContain('Network request to api.example.com')
    expect(mocks.fetched).toEqual(['https://api.example.com/v1/items?q=1'])

    const same = await app.turn([[fetchCall('f2', 'https://api.example.com/other')]], 'default', [])
    expect(asks(same)).toEqual([])
    expect(mocks.fetched).toHaveLength(2)

    for (const url of ['https://evil.api.example.com/', 'https://example.com/', 'https://api.example.com.evil.net/']) {
      expect(asks(await app.turn([[fetchCall('f3', url)]], 'default', ['deny'])), url).toHaveLength(1)
    }
    expect(mocks.fetched).toHaveLength(2)
  })

  it('keeps documentation hosts prompt-free without any rule', async () => {
    const app = harness()
    const events = await app.turn([[fetchCall('f1', 'https://docs.python.org/3/library/os.html')]], 'default', [])
    expect(asks(events)).toEqual([])
    expect(mocks.fetched).toHaveLength(1)
  })

  it('suggests a tool-wide rule for an MCP tool', async () => {
    mocks.mcpServers = [{ id: 'demo', name: 'demo', command: 'node', enabled: true }]
    const app = harness()
    const ping: ToolCall = { id: 'm1', name: 'mcp__demo__ping', input: {} }
    const first = await app.turn([[ping]], 'default', ['always'])
    expect(asks(first)[0]!.rule).toEqual({ tool: 'mcp__demo__ping', pattern: '*', label: 'ping from demo' })
    const second = await app.turn([[{ ...ping, id: 'm2' }]], 'default', [])
    expect(asks(second)).toEqual([])
    expect(mocks.pinged).toBe(2)
  })
})

describe('rules never override a hard stop', () => {
  it('keeps a policy-denied tool denied, and a hand-written rule for a dangerous command inert', async () => {
    mocks.mcpServers = [{ id: 'demo', name: 'demo', command: 'node', enabled: true }]
    // Rules a person (or an older build) wrote straight into the file: neither may approve anything.
    const saved = { workspace: mocks.workspace, pattern: '*', label: 'by hand', createdAt: 1 }
    writeFileSync(join(mocks.dataRoot, 'permission-rules.json'), JSON.stringify({ version: 1, rules: [
      { id: 'rule_locked', tool: 'mcp__demo__locked', ...saved },
      { id: 'rule_rm', tool: 'run_command', ...saved, pattern: 'rm' },
      { id: 'rule_rm_flags', tool: 'run_command', ...saved, pattern: 'rm -rf' }
    ] }))
    const app = harness()
    expect(app.service.listPermissionRules()).toHaveLength(3)
    const locked: ToolCall = { id: 'l1', name: 'mcp__demo__locked', input: {} }
    const events = await app.turn([[locked, command('c1', 'rm -rf build')]], 'default', ['deny'])
    expect(mocks.locked).toBe(0)
    expect(phases(events, 'l1')).toEqual(['running', 'error'])
    expect(events.some((e) => e.kind === 'tool' && e.tool.id === 'l1' && e.tool.detail === 'Denied by policy')).toBe(true)
    expect(asks(events).map((ask) => ask.toolName)).toEqual(['run_command']) // the dangerous command still asks
    expect(mocks.commands).toEqual([])
  })
})

describe('permission resolution', () => {
  it('ignores an unknown ask id', () => {
    const app = harness()
    expect(() => app.service.resolvePermission('no-such-ask', 'always')).not.toThrow()
    expect(app.service.listPermissionRules()).toEqual([])
  })
})
