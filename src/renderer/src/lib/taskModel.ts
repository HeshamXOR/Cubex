import type { BackgroundTask, ShellId } from '../../../shared/ipc'
import { displayOutput } from './terminalText'

/** The records one conversation keeps in the window; the main process itself keeps about this many. */
export const MAX_TASK_RECORDS = 40

type TaskState = 'running' | 'done' | 'failed' | 'timed_out' | 'stopped'

export function taskState(task: BackgroundTask): TaskState {
  switch (task.status) {
    case 'running': return 'running'
    case 'exited': return 'done'
    case 'failed': return 'failed'
    case 'timed_out': return 'timed_out'
    case 'killed': return 'stopped'
  }
}

export const isRunning = (task: BackgroundTask): boolean => task.status === 'running'

/** Running tasks first, then the finished ones, each newest first. */
export function sortTasks(tasks: readonly BackgroundTask[]): BackgroundTask[] {
  return [...tasks].sort((a, b) => {
    const live = Number(isRunning(b)) - Number(isRunning(a))
    return live || (b.startedAt - a.startedAt)
  })
}

/**
 * An update never takes a task backwards. A snapshot that was already on its way when the task ended must
 * not bring it back to "running", and a ready URL, once seen, stays.
 */
export function mergeTask(prev: BackgroundTask | undefined, next: BackgroundTask): BackgroundTask {
  if (!prev) return next
  if (!isRunning(prev) && isRunning(next)) return prev
  // Two snapshots of a finished task: the one that knows when it ended is the later one.
  if (!isRunning(prev) && prev.endedAt !== undefined && next.endedAt === undefined) return prev
  const readyHint = next.readyHint ?? prev.readyHint
  return readyHint ? { ...next, readyHint } : next
}

/** Fold a batch of snapshots into a conversation's records, keeping the newest MAX_TASK_RECORDS. */
export function mergeTasks(existing: readonly BackgroundTask[], incoming: readonly BackgroundTask[]): BackgroundTask[] {
  const byId = new Map(existing.map((task) => [task.id, task]))
  for (const task of incoming) byId.set(task.id, mergeTask(byId.get(task.id), task))
  const all = sortTasks([...byId.values()])
  if (all.length <= MAX_TASK_RECORDS) return all
  // Only finished tasks are ever dropped, oldest first.
  const running = all.filter(isRunning)
  const finished = all.filter((task) => !isRunning(task)).slice(0, Math.max(0, MAX_TASK_RECORDS - running.length))
  return sortTasks([...running, ...finished])
}

export function runningCount(tasks: readonly BackgroundTask[] | undefined): number {
  return tasks ? tasks.filter(isRunning).length : 0
}

/** How long the task has run: until now while it runs, until it ended afterwards. */
export function runtimeMs(task: BackgroundTask, now: number): number {
  return Math.max(0, (task.endedAt ?? now) - task.startedAt)
}

/** 8s, 2m 14s, 1h 05m. Whole seconds, so a ticking value never shows a changing decimal. */
export function formatRuntime(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * What the task ended with, in words. A stopped task has no exit code worth reading: it is whatever the
 * kill produced.
 */
export function statusLine(task: BackgroundTask, now: number): string {
  switch (task.status) {
    case 'running': return 'Running'
    case 'exited': return task.exitCode === undefined || task.exitCode === 0 ? 'Finished' : `Exited with code ${task.exitCode}`
    case 'failed': return task.exitCode === undefined ? 'Failed to run' : `Failed with exit code ${task.exitCode}`
    case 'timed_out': return `Reached its time limit after ${formatRuntime(runtimeMs(task, now))}`
    case 'killed': return 'Stopped'
  }
}

const SHELL_NAMES: Record<ShellId, string> = {
  'git-bash': 'Git Bash', pwsh: 'PowerShell 7', powershell: 'Windows PowerShell', cmd: 'Command Prompt', posix: 'sh'
}

export const shellName = (id: ShellId): string => SHELL_NAMES[id] ?? id

/** The last `segments` folders of a path, for a place the whole path will not fit. */
export function tailPath(path: string, segments = 2): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  if (parts.length <= segments) return path
  const separator = path.includes('\\') ? '\\' : '/'
  return `…${separator}${parts.slice(-segments).join(separator)}`
}

export type ReadyTarget =
  | { kind: 'url'; href: string; label: string }
  | { kind: 'port'; label: string }
  | { kind: 'line'; label: string }

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]'])

/**
 * What a "ready" line points at. It comes from a process's own output, so only a plain http(s) address on
 * this computer becomes a link; anything else is shown as text and never opens. 0.0.0.0 is where a server
 * listens, not an address a browser can go to, so it opens as localhost.
 */
export function readyTarget(hint: BackgroundTask['readyHint']): ReadyTarget | undefined {
  if (!hint) return undefined
  if (hint.url) {
    try {
      const url = new URL(hint.url)
      if ((url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname) && !url.username && !url.password) {
        if (url.hostname === '0.0.0.0') url.hostname = 'localhost'
        const path = url.pathname === '/' && !url.search && !url.hash ? '' : `${url.pathname}${url.search}${url.hash}`
        return { kind: 'url', href: url.href, label: `${url.host}${path}` }
      }
    } catch { /* not a URL: fall through to the plain forms */ }
  }
  if (hint.port !== undefined) return { kind: 'port', label: `Port ${hint.port}` }
  return hint.line ? { kind: 'line', label: hint.line } : undefined
}

/** Bare carriage returns redraw a progress line in place; keep what the line ended up as. */
function settleRedraws(raw: string): string {
  if (!raw.includes('\r')) return raw
  return raw.replace(/\r\n/g, '\n').split('\n').map((line) => {
    const settled = line.replace(/\r+$/, '')
    return settled.slice(settled.lastIndexOf('\r') + 1)
  }).join('\n')
}

/** Terminal output as plain lines: escape codes gone, redraws settled, at most the last `max` lines. */
export function tailLines(raw: string, max = 300): string[] {
  const lines = displayOutput(settleRedraws(raw)).split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.length > max ? lines.slice(lines.length - max) : lines
}

/** The newest line that says something, cut to a length a row can hold. */
export function lastLine(raw: string, limit = 240): string {
  const lines = tailLines(raw.length > 8_192 ? raw.slice(-8_192) : raw, 40)
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.trim()
    if (line) return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
  }
  return ''
}
