import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { PermissionMode } from '@shared/ipc'
import { createDelegatePolicy, judgeDelegated, type DelegatePolicyOptions, type DelegateQuestion } from './delegatePolicy'

// Made when the file loads, because which tests run is decided before any hook does.
const root = mkdtempSync(join(tmpdir(), 'cubex-delegate-root-'))
const outside = mkdtempSync(join(tmpdir(), 'cubex-delegate-outside-'))
mkdirSync(join(root, 'src'))
mkdirSync(join(root, '.git'))
writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n')
writeFileSync(join(outside, 'secret.txt'), 'secret')
let linked = false
try {
  symlinkSync(outside, join(root, 'escape'), 'junction')
  linked = true
} catch { /* a platform or account that cannot make links: those tests are skipped */ }

afterAll(() => {
  // The link goes first, so that removing the folder can never reach what it points to.
  try { unlinkSync(join(root, 'escape')) } catch { /* it was never made */ }
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

const OFFERED = [
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' },
  { optionId: 'never', name: 'Always reject', kind: 'reject_always' }
]

const request = (kind: string, extra: Record<string, unknown> = {}, options: unknown[] = OFFERED) => ({ toolCall: { toolCallId: 't1', title: `A ${kind}`, kind, ...extra }, options })
const at = (path: string) => ({ locations: [{ path }] })

interface Harness {
  options: DelegatePolicyOptions
  asked: DelegateQuestion[]
  kept: string[][]
  setMode: (mode: PermissionMode) => void
  answer: { value: boolean | 'throw' }
}

function harness(mode: PermissionMode = 'default', readOnly = false): Harness {
  const state = { mode }
  const asked: DelegateQuestion[] = []
  const kept: string[][] = []
  const answer: Harness['answer'] = { value: true }
  const options: DelegatePolicyOptions = {
    root,
    agent: 'Codex',
    mode: () => state.mode,
    readOnly,
    ask: async (question) => {
      asked.push(question)
      if (answer.value === 'throw') throw new Error('aborted')
      return answer.value
    },
    beforeChange: (paths) => { kept.push(paths) },
    isProtected: (path) => /(^|\/)\.git(\/|$)/.test(path),
    isReadOnlyCommand: (command) => /^(ls|git status)\b/.test(command)
  }
  return { options, asked, kept, setMode: (next) => { state.mode = next }, answer }
}

const verdict = (h: Harness, params: unknown): string => judgeDelegated(params, h.options).verdict

describe('reading', () => {
  it.each(['default', 'acceptEdits', 'plan', 'bypass'] as const)('is allowed inside the project in %s mode', (mode) => {
    const h = harness(mode)
    expect(verdict(h, request('read', at(join(root, 'src', 'a.ts'))))).toBe('allow')
    expect(verdict(h, request('search', at(join(root, 'src'))))).toBe('allow')
    expect(verdict(h, request('think'))).toBe('allow')
    expect(h.asked).toEqual([])
  })

  it.each(['read'])('asks the person when a %s names no place', async (kind) => {
    for (const mode of ['default', 'acceptEdits', 'plan'] as const) {
      const h = harness(mode)
      expect(verdict(h, request(kind))).toBe('ask')
      expect(verdict(h, request(kind, { locations: [] }))).toBe('ask')
      const judgement = judgeDelegated(request(kind), h.options)
      expect(judgement.verdict === 'ask' && judgement.question.risks.join(' ')).toMatch(/did not say what it reads/)
    }
    // The answer decides: allowed once when the person agrees, refused when they do not.
    const yes = harness('default')
    expect(await createDelegatePolicy(yes.options).decide(request(kind))).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } })
    expect(yes.asked).toHaveLength(1)
    const no = harness('default')
    no.answer.value = false
    expect(await createDelegatePolicy(no.options).decide(request(kind))).toEqual({ outcome: { outcome: 'selected', optionId: 'no' } })
  })

  it('is refused outside the project, whatever the mode', () => {
    for (const mode of ['default', 'bypass'] as const) {
      expect(verdict(harness(mode), request('read', at(join(outside, 'secret.txt'))))).toBe('reject')
    }
  })

  it.runIf(linked)('is refused through a link that leads out of the project', () => {
    expect(verdict(harness(), request('read', at(join(root, 'escape', 'secret.txt'))))).toBe('reject')
  })
})

describe('changing a file', () => {
  it('asks the person in default mode, with the file and the change', () => {
    const h = harness('default')
    const judgement = judgeDelegated(request('edit', {
      ...at(join(root, 'src', 'a.ts')),
      content: [{ type: 'diff', path: join(root, 'src', 'a.ts'), oldText: 'export const a = 1\n', newText: 'export const a = 2\n' }]
    }), h.options)
    expect(judgement.verdict).toBe('ask')
    if (judgement.verdict !== 'ask') return
    expect(judgement.question).toMatchObject({ agent: 'Codex', action: 'edit', target: 'src/a.ts', title: 'Codex wants to edit src/a.ts' })
    expect(judgement.question.detail).toContain('-export const a = 1')
    expect(judgement.question.detail).toContain('+export const a = 2')
    expect(judgement.question.risks).toEqual([])
    expect(judgement.capture).toEqual([join(root, 'src', 'a.ts')])
  })

  it('still asks in accept-edits mode about a protected place', () => {
    const judgement = judgeDelegated(request('edit', at(join(root, '.git', 'config'))), harness('acceptEdits').options)
    expect(judgement.verdict).toBe('ask')
    if (judgement.verdict === 'ask') expect(judgement.question.risks.join(' ')).toContain('Protected path')
  })

  it.each(['default', 'acceptEdits', 'bypass'] as const)('never allows a change outside the project, not even in %s mode', (mode) => {
    const h = harness(mode)
    for (const kind of ['edit', 'delete', 'move']) expect(verdict(h, request(kind, at(join(outside, 'x.txt'))))).toBe('reject')
    expect(verdict(h, request('edit', { locations: [{ path: join(root, 'src', 'ok.ts') }, { path: join(outside, 'x.txt') }] }))).toBe('reject')
    expect(h.asked).toEqual([])
  })

  it.runIf(linked)('never allows a change through a link that leads out of the project', () => {
    expect(verdict(harness('bypass'), request('edit', at(join(root, 'escape', 'new.txt'))))).toBe('reject')
  })

  it('refuses everything in plan mode', () => {
    const h = harness('plan')
    for (const kind of ['edit', 'delete', 'move', 'execute', 'fetch', 'other']) expect(verdict(h, request(kind, at(join(root, 'src', 'a.ts'))))).toBe('reject')
  })
})

describe('running a command', () => {
  it('asks in default and accept-edits mode, with the command as written', () => {
    for (const mode of ['default', 'acceptEdits'] as const) {
      const judgement = judgeDelegated(request('execute', { rawInput: { command: 'npm test' } }), harness(mode).options)
      expect(judgement.verdict).toBe('ask')
      if (judgement.verdict !== 'ask') continue
      expect(judgement.question).toMatchObject({ action: 'run', command: 'npm test', detail: 'npm test', title: 'Codex wants to run a command' })
      expect(judgement.question.risks.join(' ')).toContain('Cubex cannot limit what a command touches')
    }
  })

  it('allows a command that only looks, in any mode but plan', () => {
    expect(verdict(harness('default'), request('execute', { rawInput: { command: 'ls -la' } }))).toBe('allow')
    expect(verdict(harness('acceptEdits'), request('execute', { rawInput: { command: 'git status' } }))).toBe('allow')
  })
})

describe('everything else', () => {
  it('refuses a change of mode in every mode', () => {
    for (const mode of ['default', 'acceptEdits', 'plan', 'bypass'] as const) expect(verdict(harness(mode), request('switch_mode'))).toBe('reject')
  })

  it('asks about a kind it does not know, and names it', () => {
    const judgement = judgeDelegated(request('teleport', { title: 'Use a tool' }), harness().options)
    expect(judgement.verdict).toBe('ask')
    if (judgement.verdict === 'ask') expect(judgement.question.risks.join(' ')).toContain('teleport')
    expect(verdict(harness('acceptEdits'), request('teleport'))).toBe('ask')
    expect(verdict(harness('bypass'), request('teleport'))).toBe('allow')
  })
})

describe('a task that only reads', () => {
  it('refuses to change anything, run a command or use any other tool', () => {
    for (const mode of ['default', 'acceptEdits', 'bypass'] as const) {
      const h = harness(mode, true)
      for (const kind of ['edit', 'delete', 'move', 'execute', 'other', 'teleport']) expect(verdict(h, request(kind, at(join(root, 'src', 'a.ts'))))).toBe('reject')
      expect(verdict(h, request('read', at(join(root, 'src', 'a.ts'))))).toBe('allow')
    }
  })
})

describe('the answer to the agent', () => {
  const selected = (optionId: string) => ({ outcome: { outcome: 'selected', optionId } })
  const cancelled = { outcome: { outcome: 'cancelled' } }

  it('allows once, never always, and keeps what was there first', async () => {
    const h = harness('acceptEdits')
    const reply = await createDelegatePolicy(h.options).decide(request('edit', at(join(root, 'src', 'a.ts'))))
    expect(reply).toEqual(selected('once'))
    expect(h.kept).toHaveLength(1)
    expect(h.asked).toEqual([])
  })

  it('asks the person and follows the answer', async () => {
    const yes = harness('default')
    expect(await createDelegatePolicy(yes.options).decide(request('execute', { rawInput: { command: 'npm test' } }))).toEqual(selected('once'))
    expect(yes.asked).toHaveLength(1)

    const no = harness('default')
    no.answer.value = false
    expect(await createDelegatePolicy(no.options).decide(request('edit', at(join(root, 'src', 'a.ts'))))).toEqual(selected('no'))
    expect(no.kept).toEqual([])
  })

  it('refuses when asking the person fails', async () => {
    const h = harness('default')
    h.answer.value = 'throw'
    expect(await createDelegatePolicy(h.options).decide(request('edit', at(join(root, 'src', 'a.ts'))))).toEqual(selected('no'))
    expect(h.kept).toEqual([])
  })

  it('cancels when it can neither allow once nor refuse once', async () => {
    const h = harness('bypass')
    const onlyAlways = [{ optionId: 'always', name: 'Always', kind: 'allow_always' }, { optionId: 'never', name: 'Never', kind: 'reject_always' }]
    expect(await createDelegatePolicy(h.options).decide(request('edit', at(join(root, 'src', 'a.ts')), onlyAlways))).toEqual(cancelled)
    expect(h.kept).toEqual([])
  })

  it('reads the permission mode again for every request', async () => {
    const h = harness('default')
    const policy = createDelegatePolicy(h.options)
    await policy.decide(request('execute', { rawInput: { command: 'npm test' } }))
    expect(h.asked).toHaveLength(1)
    h.setMode('bypass')
    await policy.decide(request('execute', { rawInput: { command: 'npm test' } }))
    expect(h.asked).toHaveLength(1)
    h.setMode('plan')
    expect(await policy.decide(request('execute', { rawInput: { command: 'npm test' } }))).toEqual(selected('no'))
  })
})
