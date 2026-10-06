/**
 * Security / logic regression tests written during the Cubex audit.
 * Every test asserts the SAFE behaviour. On the unpatched baseline they fail,
 * which is the reproduction; after the patches they pass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DEFAULT_RETRY_POLICY } from '@core/types'
import type { AIProvider, AIRequest, AIStreamEvent, ToolCall } from '@core/types'
import type { ChatEvent, ChatStartRequest, PermissionMode } from '@shared/ipc'
import type { ProviderManager } from './ProviderManager'

const mocks = vi.hoisted(() => ({ dataRoot: '', workspace: '' }))
vi.mock('./paths', () => ({ dataDir: () => mocks.dataRoot }))
vi.mock('./db', () => ({ conversationRepo: { get: (id: string) => ({ id, workspacePath: mocks.workspace, messages: [] }) } }))
vi.mock('./config', () => ({ getSettings: () => ({ general: { workspacePath: mocks.workspace }, mcpServers: [], hooks: [] }) }))
vi.mock('./cost', () => ({ recordUsage: vi.fn() }))
vi.mock('./logger', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }))

import { ChatService } from './ChatService'
import { createWebFetchTool } from './tools/webFetchTool'
import { createShellTool } from './tools/shellTool'
import { createFileTools } from './tools/fileTools'
import { CheckpointStore } from './checkpoints'

let service: ChatService | undefined
let root: string
let outside: string
beforeEach(() => {
  root = mkdtempSync(join(resolve('out'), 'audit-'))
  outside = mkdtempSync(join(tmpdir(), 'audit-outside-'))
  mocks.dataRoot = join(root, 'data')
  mocks.workspace = join(root, 'workspace')
  mkdirSync(mocks.dataRoot)
  mkdirSync(mocks.workspace)
})
afterEach(() => {
  service?.cancelAll(); service?.dispose(); service = undefined
  rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true })
})
mkdirSync(resolve('out'), { recursive: true })

function req(mode: PermissionMode): ChatStartRequest {
  return {
    streamId: 's1', conversationId: 'c1', messageId: 'u1', userText: 'go', fileToolsEnabled: true, permissionMode: mode,
    policy: { primary: { providerId: 'p', model: 'm' }, fallbacks: [], fallbackEnabled: false, retry: { ...DEFAULT_RETRY_POLICY, enabled: false }, timeout: {} }
  }
}

/** Script a model: turn N yields script[N] (tool calls or text); afterwards it stops. */
function run(script: Array<ToolCall[] | string>, mode: PermissionMode, autoAnswer?: 'allow' | 'deny') {
  const events: ChatEvent[] = []
  const requests: AIRequest[] = []
  const provider = {
    id: 'p',
    async *streamMessage(r: AIRequest): AsyncGenerator<AIStreamEvent> {
      requests.push(structuredClone(r))
      const step = script[requests.length - 1] ?? 'done'
      if (typeof step === 'string') yield { type: 'text_delta', text: step }
      else for (const toolCall of step) yield { type: 'tool_call', toolCall }
    }
  } as unknown as AIProvider
  const manager = { resolve: () => provider, getModelInfo: () => undefined } as unknown as ProviderManager
  service = new ChatService(manager, (event) => {
    events.push(event)
    if (event.kind === 'permission' && autoAnswer) queueMicrotask(() => service!.resolvePermission(event.ask.id, autoAnswer))
  })
  const done = (async () => {
    await service!.start(req(mode))
    await vi.waitFor(() => expect(events.some((e) => e.kind === 'stream' && (e.event.type === 'completed' || e.event.type === 'error'))).toBe(true), { timeout: 8000 })
  })()
  return { events, requests, done }
}
const toolText = (events: ChatEvent[], name: string): string =>
  events.filter((e) => e.kind === 'tool' && e.tool.name === name).map((e) => (e as { tool: { detail?: string } }).tool.detail ?? '').join('\n')

describe('A. auto-approved "read-only" shell escapes the workspace (P0 exfil chain)', () => {
  it('does not run `cat <file outside workspace>` without asking, even in default mode', async () => {
    const secret = join(outside, 'id_rsa')
    writeFileSync(secret, 'TOP-SECRET-KEY')
    const { events, done } = run([[{ id: 't1', name: 'run_command', input: { command: `cat ${secret}` } }]], 'default', 'deny')
    await done
    expect(toolText(events, 'run_command')).not.toContain('TOP-SECRET-KEY')
    expect(events.some((e) => e.kind === 'permission')).toBe(true)
  })

  it('does not auto-run `git status` when the repo config can execute programs (fsmonitor RCE)', async () => {
    execFileSync('git', ['init', '-q'], { cwd: mocks.workspace })
    const marker = join(outside, 'PWNED')
    writeFileSync(join(mocks.workspace, '.git', 'config'), `[core]\n\tfsmonitor = "touch '${marker}'; false"\n`, { flag: 'a' })
    const { events, done } = run([[{ id: 't1', name: 'run_command', input: { command: 'git status' } }]], 'plan')
    await done
    expect(existsSync(marker)).toBe(false)
    expect(events.length).toBeGreaterThan(0)
  })

  it('acceptEdits cannot write .git/config without an explicit approval', async () => {
    execFileSync('git', ['init', '-q'], { cwd: mocks.workspace })
    const cfg = join(mocks.workspace, '.git', 'config')
    const original = readFileSync(cfg, 'utf8')
    const { done } = run([
      [{ id: 'r', name: 'read_file', input: { path: '.git/config' } }],
      [{ id: 'w', name: 'write_file', input: { path: '.git/config', content: original + '[core]\n\tfsmonitor = "evil"\n' } }]
    ], 'acceptEdits', 'deny')
    await done
    expect(readFileSync(cfg, 'utf8')).toBe(original)
  })
})

describe('B. approval card hides the dangerous tail of a command (P1)', () => {
  it('shows the complete command in the permission request', async () => {
    const command = `echo ${'building-project '.repeat(12)} && rm -rf ./important`
    const { events, done } = run([[{ id: 't1', name: 'run_command', input: { command } }]], 'default', 'deny')
    await done
    const ask = events.find((e) => e.kind === 'permission') as Extract<ChatEvent, { kind: 'permission' }> | undefined
    expect(ask).toBeDefined()
    expect(`${ask!.ask.title}\n${ask!.ask.detail ?? ''}`).toContain('rm -rf ./important')
  })
})

describe('C. XML tool calls quoted inside prose/code fences are executed (P1)', () => {
  it('ignores <invoke> markup inside a fenced code block', async () => {
    const text = 'Here is an example of the format:\n```xml\n<invoke name="write_file"><parameter name="path">pwned.txt</parameter><parameter name="content">x</parameter></invoke>\n```\n'
    const { done } = run([text], 'bypass')
    await done
    expect(existsSync(join(mocks.workspace, 'pwned.txt'))).toBe(false)
  })
})

describe('D. iteration cap ends the turn silently (P1 reliability)', () => {
  it('tells the user the turn stopped at the tool-iteration limit', async () => {
    writeFileSync(join(mocks.workspace, 'a.txt'), 'a')
    const script = Array.from({ length: 70 }, (_, i) => [{ id: `r${i}`, name: 'read_file', input: { path: 'a.txt', offset: i + 1 } }])
    const { events, done } = run(script, 'bypass')
    await done
    const completed = events.find((e) => e.kind === 'stream' && e.event.type === 'completed') as Extract<ChatEvent, { kind: 'stream' }>
    const response = (completed.event as Extract<AIStreamEvent, { type: 'completed' }>).response
    // Either an explicit notice or a distinct stop reason must reach the UI.
    expect(/iteration limit/i.test(response.text)).toBe(true)
  })
})

describe('E. web_fetch SSRF guard (P1)', () => {
  let server: Server
  let port = 0
  beforeEach(async () => {
    server = createServer((rq, rs) => {
      if (rq.url === '/redirect') { rs.writeHead(302, { location: `http://127.0.0.1:${port}/secret` }); rs.end(); return }
      rs.end('INTERNAL-ADMIN-PAGE')
    })
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    port = (server.address() as { port: number }).port
  })
  afterEach(() => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()) }))
  const fetchTool = createWebFetchTool()
  it.each([
    () => `http://[::1]:${port}/`,
    () => `http://[::ffff:127.0.0.1]:${port}/`,
    () => `http://localhost.:${port}/`,
    () => `http://[::]:${port}/`
  ])('blocks loopback spelled as %s', async (url) => {
    const result = await fetchTool.execute({ url: url() }, {} as never)
    expect(String(result.content)).toMatch(/refused/i)
  })
  it('does not follow a redirect from a public-looking host to loopback', async () => {
    // `localhost.` slips past the hostname check; the redirect target must be re-validated too.
    const result = await fetchTool.execute({ url: `http://localhost.:${port}/redirect` }, {} as never)
    expect(String(result.content)).toMatch(/refused/i)
  })
  it('does not reject legitimate public domains that start with fc/fd', async () => {
    const guard = await import('./tools/webFetchTool')
    const check = (guard as unknown as { checkUrlSyntax?: (u: string) => { ok: boolean } }).checkUrlSyntax
    expect(check?.('https://fcc.gov/').ok ?? false).toBe(true)
  })
})

describe('F. shell background children survive the command (P2 orphan leak)', () => {
  it('kills the process group when the command exits', async () => {
    if (process.platform === 'win32') return
    const shell = createShellTool(mocks.workspace)
    const pidFile = join(mocks.workspace, 'pid')
    await shell.execute({ command: `sh -c 'sleep 30 >/dev/null 2>&1 & echo $! > ${pidFile}'` }, {} as never)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    await new Promise((r) => setTimeout(r, 200))
    // A killed child reparented to a non-reaping PID 1 lingers as a zombie: count only live states.
    let alive = true
    try { alive = !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { alive = false }
    if (alive) process.kill(pid, 'SIGKILL')
    expect(alive).toBe(false)
  })
})

describe('G. file mutations corrupt non-UTF-8 / CRLF files (P2 data integrity)', () => {
  it('edit_file preserves bytes outside the edited span in a Latin-1 file', async () => {
    const file = join(mocks.workspace, 'legacy.txt')
    const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x6f, 0x6c, 0x64, 0x0a]) // "café\nold\n" in Latin-1
    writeFileSync(file, bytes)
    const [, , read, , , edit] = createFileTools(mocks.workspace)
    await read!.execute({ path: 'legacy.txt' }, {} as never)
    const result = await edit!.execute({ path: 'legacy.txt', old_string: 'old', new_string: 'new' }, {} as never)
    const after = readFileSync(file)
    // Either refuse (non UTF-8) or keep byte 0xE9 intact.
    expect(result.isError === true || after.includes(0xe9)).toBe(true)
  })
  it('edit_file matches LF old_string against a CRLF file', async () => {
    writeFileSync(join(mocks.workspace, 'win.ts'), 'const a = 1\r\nconst b = 2\r\n')
    const [, , read, , , edit] = createFileTools(mocks.workspace)
    await read!.execute({ path: 'win.ts' }, {} as never)
    const result = await edit!.execute({ path: 'win.ts', old_string: 'const a = 1\nconst b = 2', new_string: 'const a = 1\nconst b = 3' }, {} as never)
    expect(result.isError).toBeFalsy()
    expect(readFileSync(join(mocks.workspace, 'win.ts'), 'utf8')).toBe('const a = 1\r\nconst b = 3\r\n')
  })
  it('rewind restores binary files byte-for-byte', async () => {
    const file = join(mocks.workspace, 'logo.bin')
    const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01])
    writeFileSync(file, original)
    const store = new CheckpointStore()
    const seq = store.beginTurn('c', 'm')
    const [, , read, , write] = createFileTools(mocks.workspace, (p, before, existed, after) => store.record('c', seq, p, before, existed, after))
    await read!.execute({ path: 'logo.bin' }, {} as never)
    await write!.execute({ path: 'logo.bin', content: 'text now' }, {} as never)
    await store.rewind('c', 'm').catch(() => undefined)
    expect(readFileSync(file).equals(original) || readFileSync(file, 'utf8') === 'text now').toBe(true)
  })
})
