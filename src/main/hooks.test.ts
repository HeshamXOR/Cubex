import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runHooks, sampleHookPayload, sampleToolName, testHook } from './hooks'
import { hookMatches, type HookTestRequest } from '@shared/policy'
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

  it('does not block when the hook exits 0', async () => {
    const r = await runHooks([hook({ command: 'node -e "process.exit(0)"' })], { event: 'PreToolUse', tool_name: 'write_file' })
    expect(r.block).toBe(false)
  })

  it('respects the tool-name matcher', async () => {
    const r = await runHooks(
      [hook({ matcher: 'write_file', command: 'node -e "process.exit(2)"' })],
      { event: 'PreToolUse', tool_name: 'read_file' }
    )
    expect(r.block).toBe(false)
  })

  it('never blocks on non-PreToolUse events', async () => {
    const r = await runHooks(
      [hook({ event: 'PostToolUse', command: 'node -e "process.exit(2)"' })],
      { event: 'PostToolUse', tool_name: 'write_file' }
    )
    expect(r.block).toBe(false)
  })

  it('ignores disabled hooks and empty lists', async () => {
    expect((await runHooks([hook({ enabled: false, command: 'node -e "process.exit(2)"' })], { event: 'PreToolUse', tool_name: 'x' })).block).toBe(false)
    expect((await runHooks(undefined, { event: 'PreToolUse', tool_name: 'x' })).block).toBe(false)
  })

  it('matches several tools separated by |, ignoring case', async () => {
    const guard = [hook({ matcher: 'write_file|edit_file', command: 'node -e "process.exit(2)"' })]
    expect((await runHooks(guard, { event: 'PreToolUse', tool_name: 'edit_file' })).block).toBe(true)
    expect((await runHooks(guard, { event: 'PreToolUse', tool_name: 'write_file' })).block).toBe(true)
    expect((await runHooks(guard, { event: 'PreToolUse', tool_name: 'read_file' })).block).toBe(false)
    expect((await runHooks([hook({ matcher: 'WRITE', command: 'node -e "process.exit(2)"' })], { event: 'PreToolUse', tool_name: 'write_file' })).block).toBe(true)
  })

  it('treats a matcher of blanks and bars as no matcher', async () => {
    const all = [hook({ matcher: ' | ', command: 'node -e "process.exit(2)"' })]
    expect((await runHooks(all, { event: 'PreToolUse', tool_name: 'anything' })).block).toBe(true)
  })

  it('reports the reason a hook gave for blocking', async () => {
    const r = await runHooks([hook({ command: 'node -e "console.error(\'no writes to .env\'); process.exit(2)"' })], { event: 'PreToolUse', tool_name: 'write_file' })
    expect(r).toEqual({ block: true, reason: 'no writes to .env' })
  })
})

describe('testHook', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cubex-hook-')) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const request = (over: Partial<HookTestRequest>): HookTestRequest => ({ event: 'PreToolUse', command: 'node -e "process.exit(0)"', ...over })

  it('allows a hook that exits 0 and reports what it ran with', async () => {
    const r = await testHook(request({}), { workspace: root })
    expect(r).toMatchObject({ event: 'PreToolUse', outcome: 'ran', exitCode: 0, decision: 'allowed', cwd: root, cwdKind: 'project', command: 'node -e "process.exit(0)"' })
    expect(r.blockIgnored).toBeUndefined()
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('blocks on exit 2 and gives the reason from stderr', async () => {
    const r = await testHook(request({ command: 'node -e "console.error(\'protected path\'); process.exit(2)"' }), { workspace: root })
    expect(r).toMatchObject({ decision: 'blocked', exitCode: 2, reason: 'protected path', stderr: 'protected path' })
  })

  it('blocks on a decision printed as JSON', async () => {
    const r = await testHook(request({ command: 'node -e "console.log(JSON.stringify({decision:\'block\',reason:\'not today\'}))"' }), { workspace: root })
    expect(r).toMatchObject({ decision: 'blocked', exitCode: 0, reason: 'not today' })
  })

  it('does not treat other failures as a block, and says so', async () => {
    const r = await testHook(request({ command: 'node -e "process.exit(1)"' }), { workspace: root })
    expect(r).toMatchObject({ decision: 'allowed', exitCode: 1, outcome: 'ran' })
    expect(r.blockIgnored).toBeUndefined()
  })

  it('shows that an event which cannot block ignores a block signal', async () => {
    const r = await testHook(request({ event: 'PostToolUse', command: 'node -e "console.error(\'late\'); process.exit(2)"' }), { workspace: root })
    expect(r).toMatchObject({ decision: 'allowed', exitCode: 2, blockIgnored: true, reason: 'late' })
  })

  it('hands the hook the sample payload for its event on stdin', async () => {
    const echo = 'node -e "process.stdin.pipe(process.stdout)"'
    const pre = await testHook(request({ matcher: 'edit', command: echo }), { workspace: root })
    expect(JSON.parse(pre.stdout)).toEqual(JSON.parse(pre.payload))
    expect(JSON.parse(pre.payload)).toMatchObject({
      event: 'PreToolUse', tool_name: 'edit_file', cwd: root, tool_input: { path: 'src/example.ts', old_string: 'example = 1', new_string: 'example = 2' }
    })
    const post = JSON.parse((await testHook(request({ event: 'PostToolUse', command: echo }), { workspace: root })).stdout)
    expect(post).toMatchObject({ event: 'PostToolUse', tool_name: 'write_file', tool_result: 'Sample result from Cubex.' })
    expect(JSON.parse((await testHook(request({ event: 'UserPromptSubmit', command: echo }), { workspace: root })).stdout))
      .toMatchObject({ event: 'UserPromptSubmit', prompt: 'Add a retry to the upload helper.' })
    expect(JSON.parse((await testHook(request({ event: 'Stop', command: echo }), { workspace: root })).stdout)).toEqual({ event: 'Stop', cwd: root })
  })

  it('runs in the project folder, and in an empty temporary folder that it removes when there is no project', async () => {
    const where = 'node -e "console.log(process.cwd())"'
    const project = await testHook(request({ command: where }), { workspace: root })
    expect(project.cwdKind).toBe('project')
    expect(realpathSync(project.stdout)).toBe(realpathSync(root))

    for (const workspace of [undefined, join(root, 'does-not-exist')]) {
      const scratch = await testHook(request({ command: where }), { workspace })
      expect(scratch.cwdKind).toBe('scratch')
      expect(scratch.cwd).not.toBe(root)
      expect(existsSync(scratch.cwd)).toBe(false)
    }
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

describe('sample payloads', () => {
  it('picks a tool the matcher accepts', () => {
    expect(sampleToolName(undefined)).toBe('write_file')
    expect(sampleToolName('')).toBe('write_file')
    expect(sampleToolName('run')).toBe('run_command')
    expect(sampleToolName('Edit_File')).toBe('edit_file')
    expect(sampleToolName('web|git')).toBe('web_fetch')
    expect(sampleToolName('mcp__github')).toBe('mcp__github')
    expect(sampleToolName('read_file|remove_file')).toBe('read_file')
  })

  it('always passes its own matcher', () => {
    for (const matcher of ['write', 'run_command|edit', 'mcp__github__create_issue', 'FILE', 'x']) {
      expect(hookMatches(matcher, sampleToolName(matcher))).toBe(true)
    }
  })

  it('has no tool for events that do not run for one', () => {
    expect(sampleHookPayload({ event: 'Stop', command: 'x' }, 'C:\\p')).toEqual({ event: 'Stop', cwd: 'C:\\p' })
    expect(sampleHookPayload({ event: 'UserPromptSubmit', matcher: 'ignored', command: 'x' }, 'C:\\p')).not.toHaveProperty('tool_name')
  })
})
