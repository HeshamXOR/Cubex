import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PermissionMode } from '@shared/ipc'
import type { AcpPeer, DelegateActivity, DelegateRole } from '@shared/peers'
import { removeFolder } from '../testing/removeFolder'
import type { DelegateQuestion } from './acp/delegatePolicy'
import { runDelegation, type DelegateRequest } from './delegate'

// A real program, started the way an agent is: a scripted agent that speaks the protocol (acp/testing/mockAgent.cjs).
const MOCK = fileURLToPath(new URL('./acp/testing/mockAgent.cjs', import.meta.url))
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cubex-delegate-run-')))
const outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'cubex-delegate-run-out-')))
afterAll(async () => {
  await removeFolder(root)
  await removeFolder(outside)
})

const file = (name: string): string => join(root, name)
beforeEach(() => {
  for (const name of ['src', 'docs']) rmSync(file(name), { recursive: true, force: true })
  mkdirSync(file('src'))
  writeFileSync(file('src/a.ts'), 'export {}')
  writeFileSync(file('keep.txt'), 'keep')
})

const peer = (over: Partial<AcpPeer> = {}): AcpPeer => ({ kind: 'acp', id: 'mock', name: 'Mock', enabled: true, preset: 'custom', command: process.execPath, args: [MOCK], canDelegate: true, ...over })

/** Modes as real agents report them, for the mode an agent is put in. */
const CLAUDE_MODES = JSON.stringify({ current: 'plan', available: [{ id: 'default', name: 'Default' }, { id: 'acceptEdits', name: 'Accept Edits' }, { id: 'plan', name: 'Plan Mode' }, { id: 'bypassPermissions', name: 'Bypass Permissions' }] })
const CODEX_MODES = JSON.stringify({ current: 'auto', available: [{ id: 'read-only', name: 'Read Only' }, { id: 'auto', name: 'Auto' }, { id: 'full-access', name: 'Full Access' }] })
const OPENCODE_MODES = JSON.stringify({ current: 'build', available: [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }] })

interface Run {
  /** The project as the chat spells it. Defaults to its real folder. */
  workspace?: string
  mode?: PermissionMode
  role?: DelegateRole
  answer?: boolean | ((question: DelegateQuestion) => boolean)
  env?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
  peerOver?: Partial<AcpPeer>
  isReadOnlyCommand?: (command: string) => boolean
}

async function run(task: string, options: Run = {}) {
  const asked: DelegateQuestion[] = []
  const updates: DelegateActivity[] = []
  const request: DelegateRequest = {
    peer: peer(options.peerOver),
    task,
    role: options.role ?? 'implement',
    workspace: options.workspace ?? root,
    mode: () => options.mode ?? 'default',
    ask: async (question) => {
      asked.push(question)
      const answer = options.answer ?? true
      return typeof answer === 'function' ? answer(question) : answer
    },
    isProtected: (path) => /(^|\/)\.git(\/|$)/.test(path),
    isReadOnlyCommand: options.isReadOnlyCommand ?? (() => false),
    onUpdate: (activity) => updates.push(activity),
    env: { ...process.env, MOCK_MODES: CLAUDE_MODES, ...options.env },
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.signal ? { signal: options.signal } : {})
  }
  const outcome = await runDelegation(request)
  return { outcome, asked, updates }
}

describe('a task that changes a file', () => {
  it('asks the person, changes the file when they allow it, and keeps what was there', async () => {
    const { outcome, asked } = await run(`@mock edit ${file('src/a.ts')}|export const a = 2\n@mock say Done.`)
    expect(outcome.status).toBe('done')
    expect(readFileSync(file('src/a.ts'), 'utf8')).toBe('export const a = 2')
    expect(outcome.report).toContain('edit:allowed')
    expect(outcome.report).toContain('Done.')
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ agent: 'Mock', action: 'edit', target: 'src/a.ts' })
    expect(outcome.files).toEqual([{ path: 'src/a.ts', change: 'edited', tracked: true }])
    expect(outcome.captured).toHaveLength(1)
    expect(outcome.captured[0]).toMatchObject({ path: file('src/a.ts'), existed: true })
    expect(outcome.captured[0]!.before.toString()).toBe('export {}')
  })

  it('hands back the files as the chat spells the project, so that Changes and Rewind find them', async (context) => {
    // A link, a mapped drive or a short name: the agent works in the real folder, and the chat knows the project by another name.
    const link = join(outside, 'project-link')
    try { symlinkSync(root, link, 'junction') } catch { return context.skip() }
    try {
      const { outcome } = await run(['@mock edit src/a.ts|export const a = 3', '@mock say Done.'].join('\n'), { workspace: link })
      expect(outcome.status).toBe('done')
      expect(readFileSync(file('src/a.ts'), 'utf8')).toBe('export const a = 3')
      expect(outcome.files).toEqual([{ path: 'src/a.ts', change: 'edited', tracked: true }])
      expect(outcome.captured).toHaveLength(1)
      expect(outcome.captured[0]!.path).toBe(join(link, 'src', 'a.ts'))
      expect(outcome.captured[0]!.before.toString()).toBe('export {}')
    } finally {
      // Only the link goes, never the folder it points to.
      unlinkSync(link)
    }
  })

  it('leaves the file alone when the person says no', async () => {
    const { outcome } = await run(`@mock edit ${file('src/a.ts')}|changed`, { answer: false })
    expect(outcome.status).toBe('done')
    expect(readFileSync(file('src/a.ts'), 'utf8')).toBe('export {}')
    expect(outcome.report).toContain('edit:refused')
    expect(outcome.files).toEqual([])
    expect(outcome.captured).toEqual([])
  })

  it('does not ask in accept-edits mode', async () => {
    const { outcome, asked } = await run(`@mock edit ${file('src/a.ts')}|changed`, { mode: 'acceptEdits' })
    expect(asked).toEqual([])
    expect(readFileSync(file('src/a.ts'), 'utf8')).toBe('changed')
    expect(outcome.files).toEqual([{ path: 'src/a.ts', change: 'edited', tracked: true }])
  })

  it('creates a file, and says so', async () => {
    const { outcome } = await run(`@mock edit ${file('docs/new.md')}|# New`, { mode: 'bypass' })
    expect(readFileSync(file('docs/new.md'), 'utf8')).toBe('# New')
    expect(outcome.files).toEqual([{ path: 'docs/new.md', change: 'created', tracked: true }])
    expect(outcome.captured[0]).toMatchObject({ existed: false })
  })

  it('deletes a file when allowed, and keeps it for a rewind', async () => {
    const { outcome } = await run(`@mock delete ${file('keep.txt')}`)
    expect(existsSync(file('keep.txt'))).toBe(false)
    expect(outcome.files).toEqual([{ path: 'keep.txt', change: 'deleted', tracked: true }])
    expect(outcome.captured[0]!.before.toString()).toBe('keep')
  })

  it('does not call a file changed when the agent was allowed to and wrote the same thing', async () => {
    const { outcome } = await run(`@mock edit ${file('src/a.ts')}|export {}`, { mode: 'bypass' })
    expect(outcome.files).toEqual([])
    expect(outcome.captured).toEqual([])
  })

  it('never lets a change outside the project through, whatever the mode', async () => {
    for (const mode of ['default', 'acceptEdits', 'bypass'] as const) {
      const { outcome, asked } = await run(`@mock edit ${join(outside, 'x.txt')}|escaped`, { mode })
      expect(outcome.report).toContain('edit:refused')
      expect(asked).toEqual([])
      expect(existsSync(join(outside, 'x.txt'))).toBe(false)
    }
  })

  it('refuses every change in plan mode', async () => {
    const { outcome, asked } = await run(`@mock edit ${file('src/a.ts')}|changed`, { mode: 'plan' })
    expect(outcome.report).toContain('edit:refused')
    expect(asked).toEqual([])
    expect(readFileSync(file('src/a.ts'), 'utf8')).toBe('export {}')
  })
})

describe('a command', () => {
  it('asks the person, with the command', async () => {
    const { outcome, asked } = await run('@mock run npm test')
    expect(outcome.report).toContain('run:allowed npm test')
    expect(asked[0]).toMatchObject({ action: 'run', command: 'npm test' })
  })

  it('runs a read-only command without asking', async () => {
    const { outcome, asked } = await run('@mock run git status', { isReadOnlyCommand: (command) => command === 'git status' })
    expect(outcome.report).toContain('run:allowed git status')
    expect(asked).toEqual([])
  })

  it('refuses a command when the person says no', async () => {
    const { outcome } = await run('@mock run rm -rf node_modules', { answer: false })
    expect(outcome.report).toContain('run:refused')
  })
})

describe('what the agent changed without asking', () => {
  it('is found by comparing the folder, and said not to be kept', async () => {
    const { outcome } = await run(`@mock sneak ${file('src/sneaky.ts')}|oops\n@mock say ok`)
    expect(outcome.status).toBe('done')
    expect(outcome.files).toEqual([{ path: 'src/sneaky.ts', change: 'created', tracked: false }])
    expect(outcome.captured).toEqual([])
  })

  it('is listed with what it asked about, each as what it is', async () => {
    const { outcome } = await run(`@mock edit ${file('src/a.ts')}|changed\n@mock sneak ${file('src/sneaky.ts')}|oops`, { mode: 'acceptEdits' })
    expect(outcome.files).toEqual([
      { path: 'src/a.ts', change: 'edited', tracked: true },
      { path: 'src/sneaky.ts', change: 'created', tracked: false }
    ])
  })
})

describe('a task that only reads', () => {
  it.each(['research', 'review'] as const)('may not change anything in a %s task, whatever the mode', async (role) => {
    const { outcome, asked } = await run(`@mock edit ${file('src/a.ts')}|changed\n@mock run npm test`, { role, mode: 'bypass' })
    expect(outcome.report).toContain('edit:refused')
    expect(outcome.report).toContain('run:refused')
    expect(asked).toEqual([])
    expect(readFileSync(file('src/a.ts'), 'utf8')).toBe('export {}')
  })

  it('puts the agent in its most careful mode', async () => {
    const { outcome } = await run('@mock modes', { role: 'research' })
    expect(outcome.report).toBe('mode:plan')
  })
})

describe('the mode the agent works in', () => {
  it('puts Claude Code in the mode that asks', async () => {
    const { outcome } = await run('@mock modes')
    expect(outcome.report).toBe('mode:default')
  })

  it('puts Codex in read-only, which asks before it edits', async () => {
    const { outcome } = await run('@mock modes', { env: { MOCK_MODES: CODEX_MODES } })
    expect(outcome.report).toBe('mode:read-only')
  })

  it('refuses an agent that has no mode that asks, and says what to do', async () => {
    const { outcome } = await run('@mock modes', { env: { MOCK_MODES: OPENCODE_MODES } })
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('no mode in which it asks before it changes things')
    expect(outcome.error).toContain('Build, Plan')
    expect(outcome.hint).toContain('research or review')
  })

  it('still lets that agent research, in its read-only mode', async () => {
    const { outcome } = await run('@mock modes', { role: 'research', env: { MOCK_MODES: OPENCODE_MODES } })
    expect(outcome.status).toBe('done')
    expect(outcome.report).toBe('mode:plan')
  })

  it('stops an agent that moves itself into a mode that does not ask', async () => {
    const { outcome } = await run('@mock mode bypassPermissions')
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('moved itself into the mode')
  })
})

describe('what is shown while it works', () => {
  it('reports each step the agent takes, and when it is waiting for the person', async () => {
    const answers: boolean[] = []
    const { outcome, updates } = await run(`@mock step Read the project\n@mock edit ${file('src/a.ts')}|changed\n@mock step Run the tests`, { answer: () => { answers.push(true); return true } })
    expect(outcome.steps.map((step) => [step.title, step.state])).toEqual([['Read the project', 'done'], ['Run the tests', 'done']])
    expect(answers).toHaveLength(1)
    expect(updates.length).toBeGreaterThan(1)
    expect(updates.some((update) => update.status === 'waiting')).toBe(true)
    expect(updates[0]).toMatchObject({ name: 'Mock', role: 'implement', status: 'working' })
  })

  it('shows the files it has been allowed to change so far', async () => {
    const { updates } = await run(`@mock edit ${file('src/a.ts')}|changed\n@mock step After the edit`)
    expect(updates.at(-1)?.files).toEqual([{ path: 'src/a.ts', change: 'edited', tracked: true }])
  })
})

describe('when it does not go well', () => {
  it('says a program that cannot be started was not found', async () => {
    const { outcome } = await run('anything', { peerOver: { command: 'cubex-no-such-agent-xyz', args: [] } })
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('was not found')
    expect(outcome.files).toEqual([])
  })

  it('says an agent that declines declined', async () => {
    const { outcome } = await run('@mock refuse')
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('declined the task')
  })

  it('says when the agent stopped early, and that the work may be incomplete', async () => {
    const { outcome } = await run('@mock say Half done.\n@mock max_turn_requests')
    expect(outcome.status).toBe('done')
    expect(outcome.stoppedEarly).toContain('used all the steps')
    expect(outcome.report).toBe('Half done.')
  })

  it('gives up on an agent that takes too long, and says so', async () => {
    const { outcome } = await run('@mock hang', { timeoutMs: 400 })
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toMatch(/did not answer within/)
  })

  it('stops when the turn is cancelled, and keeps what had been changed', async () => {
    const controller = new AbortController()
    const started = run(`@mock edit ${file('src/a.ts')}|changed\n@mock hang`, { mode: 'acceptEdits', signal: controller.signal })
    // Cancel once the agent has really made its edit, however long a loaded machine takes to get there.
    await vi.waitFor(() => expect(readFileSync(file('src/a.ts'), 'utf8')).toBe('changed'), { timeout: 20_000, interval: 25 })
    controller.abort()
    const { outcome } = await started
    expect(outcome.status).toBe('cancelled')
    expect(outcome.files).toEqual([{ path: 'src/a.ts', change: 'edited', tracked: true }])
    expect(outcome.captured).toHaveLength(1)
  })

  it('does not start when it is already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const { outcome } = await run('@mock say hi', { signal: controller.signal })
    expect(outcome.status).toBe('cancelled')
  })

  it('reports an agent whose program ends in the middle', async () => {
    const { outcome } = await run('@mock say hi', { env: { MOCK_EXIT_AT_PROMPT: '4' } })
    expect(outcome.status).toBe('failed')
    expect(outcome.error).toContain('stopped unexpectedly')
  })
})

describe('what the agent is told', () => {
  it('gets the task, and nothing else of the conversation', async () => {
    const { outcome } = await run('@mock echo')
    expect(outcome.report).toContain('You have been handed a task by another AI agent')
    expect(outcome.report).toContain('Work in this folder only')
    expect(outcome.report).toContain('The task:')
  })

  it('is told it may not change anything, for a task that only reads', async () => {
    const { outcome } = await run('@mock echo', { role: 'review' })
    expect(outcome.report).toContain('Do not edit, create, delete or move any file')
    expect(outcome.report).toContain('Review what the task points at')
  })
})
