import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runHooks, testHook } from './hooks'
import { removeFolder } from './testing/removeFolder'
import { type HookTestRequest } from '@shared/policy'
import type { HookConfig } from '@shared/settings'

const hook = (over: Partial<HookConfig>): HookConfig => ({
  id: 'h',
  event: 'PreToolUse',
  command: '',
  enabled: true,
  ...over
})

describe('runHooks', () => {
  it('blocks a PreToolUse call when a matching hook exits 2', async () => {
    const r = await runHooks([hook({ command: 'node -e "process.exit(2)"' })], { event: 'PreToolUse', tool_name: 'write_file' })
    expect(r.block).toBe(true)
  })

  it('respects the tool-name matcher', async () => {
    const r = await runHooks(
      [hook({ matcher: 'write_file', command: 'node -e "process.exit(2)"' })],
      { event: 'PreToolUse', tool_name: 'read_file' }
    )
    expect(r.block).toBe(false)
  })

  it('lets a Stop hook ask for more work with exit 2 or a block decision, and passes its reason on', async () => {
    const byExit = await runHooks(
      [hook({ event: 'Stop', command: 'node -e "console.error(\'Run the tests first.\'); process.exit(2)"' })],
      { event: 'Stop', stop_hook_active: false }
    )
    expect(byExit).toEqual({ block: true, reason: 'Run the tests first.' })
    const byJson = await runHooks(
      [hook({ event: 'Stop', command: 'node -e "console.log(JSON.stringify({ decision: \'block\', reason: \'Lint is failing.\' }))"' })],
      { event: 'Stop' }
    )
    expect(byJson).toEqual({ block: true, reason: 'Lint is failing.' })
    const allowed = await runHooks([hook({ event: 'Stop', command: 'node -e "process.exit(0)"' })], { event: 'Stop' })
    expect(allowed.block).toBe(false)
  })
})

describe('testHook', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cubex-hook-')) })
  afterEach(() => removeFolder(root))

  const request = (over: Partial<HookTestRequest>): HookTestRequest => ({ event: 'PreToolUse', command: 'node -e "process.exit(0)"', ...over })

  it('blocks on exit 2 and gives the reason from stderr', async () => {
    const r = await testHook(request({ command: 'node -e "console.error(\'protected path\'); process.exit(2)"' }), { workspace: root })
    expect(r).toMatchObject({ decision: 'blocked', exitCode: 2, reason: 'protected path', stderr: 'protected path' })
  })

  it('stops a hook that runs past the time limit and says it timed out', async () => {
    const started = Date.now()
    const r = await testHook(request({ command: 'node -e "setTimeout(() => {}, 20000)"' }), { workspace: root, timeoutMs: 400 })
    expect(Date.now() - started).toBeLessThan(8000)
    expect(r).toMatchObject({ outcome: 'timed-out', decision: 'allowed' })
  })

  it('caps long output, strips color codes and redacts secrets', async () => {
    const long = await testHook(request({ command: 'node -e "console.log(\'x\'.repeat(20000))"' }), { workspace: root })
    expect(long.stdout.length).toBeLessThanOrEqual(8 * 1024)
    expect(long.truncated).toBe(true)

    const colored = await testHook(request({ command: 'node -e "console.log(\'\\u001b[31mred\\u001b[0m\')"' }), { workspace: root })
    expect(colored.stdout).toBe('red')

    const secret = await testHook(request({ command: 'node -e "console.log(\'key sk-ant-abcdefghijklmnopqrstuv\')"' }), { workspace: root })
    expect(secret.stdout).toBe('key «redacted»')
  })

  it('does not hand the hook Cubex credentials from the environment', async () => {
    process.env.CUBEX_TEST_SECRET = 'leak'
    try {
      const r = await testHook(request({ command: 'node -e "console.log(process.env.CUBEX_TEST_SECRET ?? \'absent\')"' }), { workspace: root })
      expect(r.stdout).toBe('absent')
    } finally {
      delete process.env.CUBEX_TEST_SECRET
    }
  })
})

describe('hooks v2 results', () => {
  const printing = (json: string): string => `node -e "console.log(JSON.stringify(${json}))"`

  it('lets a UserPromptSubmit hook block with exit 2 or a block decision', async () => {
    const byExit = await runHooks(
      [hook({ event: 'UserPromptSubmit', command: 'node -e "console.error(\'No secrets.\'); process.exit(2)"' })],
      { event: 'UserPromptSubmit', prompt: 'hi' }
    )
    expect(byExit).toEqual({ block: true, reason: 'No secrets.' })
    const byJson = await runHooks(
      [hook({ event: 'UserPromptSubmit', command: printing("{ decision: 'block', reason: 'Not now.' }") })],
      { event: 'UserPromptSubmit', prompt: 'hi' }
    )
    expect(byJson).toEqual({ block: true, reason: 'Not now.' })
  })

  it('returns the updatedInput a PreToolUse hook prints, and the next hook sees it', async () => {
    const r = await runHooks(
      [hook({ command: printing("{ updatedInput: { path: 'safe.txt' } }") }),
        // exits 2 only when it received the replaced input
        hook({ id: 'h2', command: 'node -e "let d=\'\';process.stdin.on(\'data\',c=>d+=c).on(\'end\',()=>process.exit(JSON.parse(d).tool_input.path===\'safe.txt\'?2:0))"' })],
      { event: 'PreToolUse', tool_name: 'write_file', tool_input: { path: 'unsafe.txt' } }
    )
    expect(r.block).toBe(true)
    const only = await runHooks([hook({ command: printing("{ updatedInput: { path: 'safe.txt' } }") })], { event: 'PreToolUse', tool_name: 'write_file', tool_input: { path: 'x' } })
    expect(only).toEqual({ block: false, updatedInput: { path: 'safe.txt' } })
    const notAnObject = await runHooks([hook({ command: printing("{ updatedInput: 'nope' }") })], { event: 'PreToolUse', tool_name: 'write_file' })
    expect(notAnObject).toEqual({ block: false })
  })

  it('a hook that times out never blocks or changes anything', async () => {
    const r = await testHook({ event: 'UserPromptSubmit', command: 'node -e "setTimeout(()=>{}, 60000)"' }, { timeoutMs: 300 })
    expect(r.outcome).toBe('timed-out')
    expect(r.decision).toBe('allowed')
  })
})
