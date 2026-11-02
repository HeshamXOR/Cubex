import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, it, expect, vi } from 'vitest'
import { createShellTool, isReadOnlyShellCommand } from './shellTool'
import { CommandOutputStore } from '../commandOutput'
import type { ToolExecutionContext } from '@core/types'

const ctx: ToolExecutionContext = { requestPermission: async () => ({ decision: 'allow' }) }

function running(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeout = 5_000): Promise<void> {
  const until = Date.now() + timeout
  while (!(await check())) {
    if (Date.now() >= until) throw new Error('Process fixture did not reach the expected state.')
    await delay(30)
  }
}

async function shellTreeFixture(): Promise<{
  directory: string
  command: string
  pids: () => Promise<number[]>
  dispose: () => Promise<void>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'cubex-shell-test-'))
  const pidFile = join(directory, 'processes.json')
  const script = join(directory, 'tree.cjs')
  await writeFile(script, [
    "const { spawn } = require('node:child_process')",
    "const { writeFileSync } = require('node:fs')",
    // A hard deadline prevents an assertion failure leaving a permanent fixture.
    "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { stdio: 'inherit' })",
    // A POSIX shell may exec Node directly, making the runner its parent.
    `child.on('spawn', () => { const shell = process.ppid === ${process.pid} ? [] : [process.ppid]; writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([...shell, process.pid, child.pid])); console.log('tree-ready') })`,
    'setTimeout(() => {}, 15000)'
  ].join('\n'))
  const pids = async (): Promise<number[]> => JSON.parse(await readFile(pidFile, 'utf8')) as number[]
  return {
    directory,
    command: `"${process.execPath}" "${script}"`,
    pids,
    dispose: async () => {
      // Independent cleanup keeps failures from leaking the fixture processes.
      const processIds = await pids().catch(() => [])
      for (const pid of [...processIds].reverse()) {
        if (!running(pid)) continue
        try { process.kill(pid, 'SIGKILL') } catch { /* Already gone. */ }
      }
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
}

describe('isReadOnlyShellCommand', () => {
  it('allows clearly read-only commands', () => {
    for (const c of ['ls', 'ls -la src', 'pwd', 'cat package.json', 'git status', 'git diff HEAD', 'node --version', 'npm ls']) {
      expect(isReadOnlyShellCommand(c)).toBe(true)
    }
  })

  it('rejects mutations, script execution, and any shell operators', () => {
    for (const c of ['rm -rf build', 'git commit -m x', 'npm run build', 'node script.js', 'ls; rm x', 'cat a && rm b', 'echo hi > f', 'cat x | sh', '']) {
      expect(isReadOnlyShellCommand(c)).toBe(false)
    }
  })

  it('distinguishes Git inspection from argument-dependent mutations', () => {
    for (const command of ['git branch', 'git branch --list feature', 'git tag --list', 'git remote -v', 'git config --get user.name', 'git config --list', 'cat "src/my file.ts"']) {
      expect(isReadOnlyShellCommand(command), command).toBe(true)
    }
    for (const command of ['git branch new-feature', 'git branch -D main', 'git tag release', 'git tag -d release',
      'git remote add origin https://example.com/repo', 'git config user.name changed', 'git config --global --unset user.name',
      'git diff --output patch.diff', 'git log --ext-diff', 'git show --textconv HEAD', 'git -c alias.x=bad x']) {
      expect(isReadOnlyShellCommand(command), command).toBe(false)
    }
  })

  it('does not auto-approve executors, mutating probe flags, or Windows expansion', () => {
    for (const command of ['find . -delete', 'find . -exec rm x', 'rg --pre script pattern', 'rg --pre=script pattern',
      'file -C', 'date -s 2030-01-01', 'hostname changed', 'node', 'npx', 'python --noEmit',
      'type %SECRET_FILE%', 'echo !VAR!', 'echo hi^&calc', 'cat "unterminated']) {
      expect(isReadOnlyShellCommand(command), command).toBe(false)
    }
  })
})

describe('run_command tool', () => {

  it('runs a command and returns exit code + output', async () => {
    const res = await createShellTool(process.cwd()).execute({ command: 'echo cubex-ok' }, ctx)
    expect(res.isError).toBeFalsy()
    expect(String(res.content)).toContain('cubex-ok')
    expect(String(res.content)).toContain('Exit code: 0')
  })

  it('distinguishes operating-system denials from Cubex permission approval and gives a recovery path', async () => {
    const result = await createShellTool(process.cwd()).execute({ command: 'node -e "process.stderr.write(\'Access is denied.\'); process.exitCode = 255"' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Exit code: 255')
    expect(result.content).toContain('Access is denied.')
    expect(result.content).toContain('Cubex approval does not override file or process permissions')
    expect(result.content).toContain('Do not repeat the same command unchanged')
    expect(result.content).toContain('read_file or search_files')
    expect(result.metadata?.failureCategory).toBe('permission_denied')
  })

  it('saves output omitted from the inline preview and exposes a typed output id', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cubex-command-output-test-'))
    try {
      const store = new CommandOutputStore(directory)
      const onSaved = vi.fn()
      const tool = createShellTool(process.cwd(), { outputStore: store, conversationId: 'task', onOutputSaved: onSaved })
      const result = await tool.execute({ command: 'node -e "process.stdout.write(\'prefix-\' + \'x\'.repeat(70000) + \'-suffix\'); process.stderr.write(\'stderr-marker\')"' }, ctx)
      expect(result.isError).toBe(false)
      const id = String(result.metadata?.commandOutputId)
      expect(id).toMatch(/^[a-f0-9-]{36}$/)
      expect(result.content).toContain('chars truncated')
      expect(result.content).toContain('read_command_output')
      expect(store.get('task', id)).toMatchObject({ status: 'completed', exitCode: 0, truncated: false })
      let offset = 0
      let full = ''
      do {
        const page = store.read('task', id, { offset })!
        full += page.text
        if (page.eof) break
        offset = page.nextOffset!
      } while (true)
      expect(full).toContain('prefix-' + 'x'.repeat(70000) + '-suffix')
      expect(full).toContain('stderr-marker')
      expect(result.content).toContain(`${full.length - 30000} chars truncated`)
      expect(onSaved.mock.calls.map(([artifact]) => artifact.status)).toEqual(['running', 'completed'])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('does not start an already-cancelled command', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await createShellTool(join(tmpdir(), 'cubex-workspace-does-not-exist')).execute(
      { command: 'echo should-not-run' }, { ...ctx, signal: controller.signal }
    )
    expect(result.isError).toBe(true)
    expect(result.content).toBe('run_command cancelled.')
  })

  it('cancels the shell and its live descendants and releases the abort listener', async ({ skip }) => {
    const fixture = await shellTreeFixture()
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    const execution = createShellTool(fixture.directory).execute(
      { command: fixture.command }, { ...ctx, signal: controller.signal }
    )
    try {
      await waitUntil(async () => (await fixture.pids().catch(() => [])).length >= 2)
      const pids = await fixture.pids()
      expect(pids.every(running)).toBe(true)
      controller.abort()
      const result = await execution
      expect(result.isError).toBe(true)
      expect(result.content).toContain('Command was cancelled.')
      if (process.platform === 'win32' && /Termination warning:.*access (?:is )?denied/i.test(String(result.content))) {
        console.warn('Skipping real process-tree assertion: this Windows sandbox denies taskkill access to its own child processes.')
        skip()
      }
      expect(result.content).not.toContain('Termination warning')
      await waitUntil(() => pids.every((pid) => !running(pid)))
      expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    } finally {
      controller.abort()
      await execution
      removeListener.mockRestore()
      await fixture.dispose()
    }
  }, 20_000)

  it('times out and terminates descendants instead of waiting on their output handles', async ({ skip }) => {
    const fixture = await shellTreeFixture()
    try {
      const result = await createShellTool(fixture.directory).execute({ command: fixture.command, timeout_ms: 2_000 }, ctx)
      const pids = await fixture.pids()
      expect(result.isError).toBe(true)
      if (process.platform === 'win32' && /Termination warning:.*access (?:is )?denied/i.test(String(result.content))) {
        console.warn('Skipping real process-tree assertion: this Windows sandbox denies taskkill access to its own child processes.')
        skip()
      }
      expect(result.content).toContain('Command timed out after 2000ms and was killed.')
      expect(result.content).toContain('tree-ready')
      await waitUntil(() => pids.every((pid) => !running(pid)))
    } finally {
      await fixture.dispose()
    }
  }, 20_000)

  it('delegates background execution to processManager when provided', async () => {
    const mockProcessManager = {
      start: vi.fn().mockResolvedValue({
        task: {
          id: 'p_bg123',
          conversationId: 'c1',
          command: 'npm run dev',
          shell: 'cmd',
          cwd: process.cwd(),
          status: 'running',
          startedAt: 1000,
          outputId: 'out_bg',
          readyHint: { line: 'VITE ready on http://localhost:5173' }
        },
        initialOutput: 'VITE ready on http://localhost:5173\n',
        exited: false
      })
    } as any

    const tool = createShellTool(process.cwd(), {
      processManager: mockProcessManager,
      conversationId: 'c1'
    })

    const result = await tool.execute({
      command: 'npm run dev',
      background: true,
      yield_ms: 5000
    }, ctx)

    expect(result.isError).toBe(false)
    expect(result.content).toContain('Background task started with ID: p_bg123')
    expect(result.content).toContain('Ready: VITE ready on http://localhost:5173')
    expect(result.metadata).toEqual({ taskId: 'p_bg123', commandOutputId: 'out_bg' })
    expect(mockProcessManager.start).toHaveBeenCalled()
  })
})

describe('run_command shell choice', () => {
  const windows = process.platform === 'win32'

  it.skipIf(!windows)('runs a foreground command in the shell the user chose, not always cmd.exe', async () => {
    const asked = await createShellTool(process.cwd(), { preferredShell: 'powershell' }).execute({ command: '$PSVersionTable.PSVersion.Major' }, ctx)
    expect(asked.isError).toBe(false)
    expect(String(asked.content)).toMatch(/Exit code: 0\s+\d/)

    const cmd = await createShellTool(process.cwd(), { preferredShell: 'cmd' }).execute({ command: 'ver' }, ctx)
    expect(String(cmd.content)).toContain('Microsoft Windows')
  })

  it('says so when the chosen shell is not installed and names the one that ran instead', async () => {
    const missing = windows ? 'posix' : 'cmd'
    const res = await createShellTool(process.cwd(), { preferredShell: missing }).execute({ command: 'echo still-runs' }, ctx)
    expect(res.isError).toBe(false)
    expect(String(res.content)).toContain('still-runs')
    expect(String(res.content)).toContain(`Note: ${missing} is not installed, so this ran in`)
  })
})

describe('run_command background tasks', () => {
  const task = (status: string, exitCode?: number) => ({
    task: { id: 'p_bg', conversationId: 'c1', command: 'npm run dev', shell: 'cmd', cwd: process.cwd(), status, startedAt: 1, outputId: 'o', ...(exitCode !== undefined ? { exitCode } : {}) },
    initialOutput: 'bye',
    exited: true
  })

  it('hands the turn it serves to the process manager, so Stop on that turn can end the task', async () => {
    const start = vi.fn().mockResolvedValue({ ...task('running'), exited: false })
    const tool = createShellTool(process.cwd(), { processManager: { start } as never, conversationId: 'c1', turnId: 'turn-7' })
    await tool.execute({ command: 'npm run dev', background: true }, ctx)
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'c1', turnId: 'turn-7', background: true }))
  })

  it('does not call a task that was stopped a failure, and does not report the kill as its exit code', async () => {
    const start = vi.fn().mockResolvedValue(task('killed', 1))
    const res = await createShellTool(process.cwd(), { processManager: { start } as never, conversationId: 'c1' }).execute({ command: 'x', background: true }, ctx)
    expect(res.isError).toBe(false)
    expect(String(res.content)).toContain('The task was stopped before it finished.')
    expect(String(res.content)).not.toContain('Exit code')
  })
})

