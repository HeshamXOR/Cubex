import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ToolActivity } from '@shared/ipc'
import { hydrateMessageTranscript, serializeMessageTranscript } from '@shared/messageTranscript'
import { childEnvironment } from './childEnv'
import { CommandOutputStore } from './commandOutput'
import { PlanStore } from './plans'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cubex-followups-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('child process environment', () => {
  it('strips provider secrets regardless of case but keeps what spawning needs', () => {
    const env = childEnvironment({
      Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', ComSpec: 'cmd.exe', HOME: '/home/u',
      anthropic_api_key: 'a', OPENAI_API_KEY: 'b', Cubex_Secret: 'c', GITHUB_TOKEN: 'd', AWS_SECRET_ACCESS_KEY: 'e'
    })
    expect(env).toMatchObject({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', ComSpec: 'cmd.exe', HOME: '/home/u' })
    for (const key of ['anthropic_api_key', 'OPENAI_API_KEY', 'Cubex_Secret', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY']) {
      expect(env[key]).toBeUndefined()
    }
  })
})

describe('conversation delete cascade', () => {
  it('removes every plan revision of the conversation and nothing else', () => {
    const plans = new PlanStore(join(dir, 'plans'))
    const mine = plans.create('conv-a', { plan: '# A\n\n1. step' })
    const other = plans.create('conv-b', { plan: '# B\n\n1. step' })
    plans.deleteConversation('conv-a')
    expect(existsSync(dirname(mine.path!))).toBe(false)
    expect(plans.list('conv-a')).toEqual([])
    expect(plans.list('conv-b').map((plan) => plan.id)).toEqual([other.id])
  })

  it('removes finished command output but never an active capture', () => {
    const outputs = new CommandOutputStore(join(dir, 'out'))
    const done = outputs.create('conv-a', { command: 'echo hi' })
    done.append('hi\n')
    done.finish({ status: 'completed', exitCode: 0 })
    const running = outputs.create('conv-b', { command: 'npm run dev' })
    outputs.deleteConversation('conv-a')
    outputs.deleteConversation('conv-b')
    expect(outputs.list('conv-a')).toEqual([])
    expect(outputs.list('conv-b').map((output) => output.id)).toEqual([running.id])
    running.finish({ status: 'cancelled' })
  })
})

describe('queued tool phase persistence', () => {
  it('restores a call that never started as not executed, never as running or done', () => {
    const queued: ToolActivity = { id: 'q', name: 'run_command', phase: 'queued' }
    const stored = serializeMessageTranscript({ toolCalls: [queued] })!
    const restored = hydrateMessageTranscript({ uiTranscriptJson: stored }).toolCalls?.[0]
    expect(restored).toMatchObject({ phase: 'error', interrupted: true })
    expect(restored?.detail).toContain('Not executed')
  })
})

describe('Windows program shadowing', () => {
  it('refuses to auto-approve a probe whose program name exists in the workspace', async () => {
    const { writeFileSync } = await import('node:fs')
    const { shadowedByWorkspace } = await import('./tools/shellReadOnly')
    writeFileSync(join(dir, 'ls.bat'), '@echo pwned')
    expect(shadowedByWorkspace('ls', dir, 'win32')).toBe(true)
    expect(shadowedByWorkspace('cat', dir, 'win32')).toBe(false)
    expect(shadowedByWorkspace('ls', dir, 'linux')).toBe(false)
  })

  it('pins the child environment against current-directory program lookup', () => {
    if (process.platform !== 'win32') return
    expect(childEnvironment({ Path: 'C:\Windows' }).NoDefaultCurrentDirectoryInExePath).toBe('1')
  })
})
