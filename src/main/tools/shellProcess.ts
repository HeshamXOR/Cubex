import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

const KILL_TIMEOUT = 5_000

/**
 * taskkill reports a process that ended on its own, between listing the tree and stopping it, as an error, and
 * exits non-zero. Everything it names was already gone, which is what stopping the tree was meant to achieve.
 */
function onlyVanishedProcesses(output: string): boolean {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  let sawError = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!/^ERROR:/i.test(line)) continue
    sawError = true
    const reason = /^Reason:/i.test(lines[i + 1] ?? '') ? lines[i + 1]! : ''
    if (!/not found/i.test(line) && !/no running instance/i.test(reason)) return false
  }
  return sawError
}

/**
 * Stop the shell tree without yielding to the event loop. The quit path needs
 * this: Electron tears the process down as soon as `before-quit` returns, so an
 * awaited kill never completes and descendants keep holding ports.
 */
export function terminateShellTreeSync(child: ChildProcess, platform = process.platform): string | undefined {
  if (!child.pid) return undefined

  if (platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return undefined
      try { child.kill('SIGKILL') } catch { /* Report the tree failure below. */ }
      return `Could not terminate the process group: ${(error as Error).message}`
    }
  }

  try {
    // Arguments stay separate: neither the PID nor executable is shell code.
    const res = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
      timeout: KILL_TIMEOUT
    })
    if (res.error) throw res.error
    if (res.status !== 0) {
      try { child.kill('SIGKILL') } catch { /* Keep the original failure. */ }
      return `Process-tree termination exited with code ${res.status ?? 'unknown'}.`
    }
    return undefined
  } catch (error) {
    try { child.kill('SIGKILL') } catch { /* Keep the original failure. */ }
    return `Could not terminate the process tree: ${(error as Error).message}`
  }
}

/** Stop the shell and its descendants, including children holding output pipes open. */
export async function terminateShellTree(child: ChildProcess, platform = process.platform): Promise<string | undefined> {
  if (!child.pid) return undefined

  if (platform !== 'win32') {
    try {
      // run_command starts its shell in a dedicated process group on POSIX.
      process.kill(-child.pid, 'SIGKILL')
      return undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return undefined
      try { child.kill('SIGKILL') } catch { /* Report the tree failure below. */ }
      return `Could not terminate the process group: ${(error as Error).message}`
    }
  }

  return await new Promise<string | undefined>((resolve) => {
    let finished = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (warning?: string): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (warning) {
        try { child.kill('SIGKILL') } catch { /* Keep the original failure. */ }
      }
      resolve(warning)
    }

    try {
      // Arguments stay separate: neither the PID nor executable is shell code.
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let detail = ''
      const onData = (data: Buffer): void => { detail = (detail + data.toString()).slice(-2_000) }
      killer.stdout?.on('data', onData)
      killer.stderr?.on('data', onData)
      killer.once('error', (error) => finish(`Could not terminate the process tree: ${error.message}`))
      killer.once('close', (code) => {
        if (code === 0 || onlyVanishedProcesses(detail)) finish()
        else finish(`Process-tree termination exited with code ${code ?? 'unknown'}.${detail.trim() ? ` ${detail.trim()}` : ''}`)
      })
      timer = setTimeout(() => {
        try { killer.kill() } catch { /* Fall back to stopping the shell. */ }
        finish('Process-tree termination did not finish within 5 seconds.')
      }, KILL_TIMEOUT)
    } catch (error) {
      finish(`Could not terminate the process tree: ${(error as Error).message}`)
    }
  })
}
