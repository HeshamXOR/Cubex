import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PermissionMode } from '@shared/ipc'
import type { TaskSpec } from './types'

export const EVALS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const TASKS_ROOT = join(EVALS_ROOT, 'tasks')

const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypass']

function str(value: unknown, field: string, slug: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${slug}/task.json: "${field}" must be a non-empty string.`)
  return value
}

/** Read one task folder. Throws with the task's name when its task.json is malformed. */
export function loadTask(slug: string, root: string = TASKS_ROOT): TaskSpec {
  const dir = join(root, slug)
  const raw = JSON.parse(readFileSync(join(dir, 'task.json'), 'utf8')) as Record<string, unknown>
  const mode = (raw.mode ?? 'bypass') as PermissionMode
  if (!MODES.includes(mode)) throw new Error(`${slug}/task.json: unknown mode "${String(raw.mode)}".`)
  if (!existsSync(join(dir, 'fixture'))) throw new Error(`${slug}: there is no fixture/ folder.`)
  let check: TaskSpec['check']
  if (typeof raw.checkCommand === 'string' && raw.checkCommand.trim()) check = { kind: 'command', command: raw.checkCommand }
  else {
    const file = typeof raw.check === 'string' ? raw.check : 'check.mjs'
    if (!existsSync(join(dir, file))) throw new Error(`${slug}: the check ${file} does not exist.`)
    check = { kind: 'script', file }
  }
  const declared = typeof raw.timeoutSec === 'number' && raw.timeoutSec > 0 ? raw.timeoutSec : 300
  // CUBEX_EVAL_TIMEOUT_SEC caps every task, for a quick smoke run.
  const cap = Number(process.env.CUBEX_EVAL_TIMEOUT_SEC)
  const timeoutSec = cap > 0 ? Math.min(declared, cap) : declared
  const stub = (raw.stub ?? {}) as TaskSpec['stub']
  return {
    slug, dir,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : slug,
    prompt: str(raw.prompt, 'prompt', slug),
    mode,
    timeoutMs: timeoutSec * 1000,
    requires: Array.isArray(raw.requires) ? raw.requires.filter((item): item is string => typeof item === 'string') : [],
    subagents: raw.subagents === true,
    check,
    stub: { ...(typeof stub.answer === 'string' ? { answer: stub.answer } : {}), ...(typeof stub.command === 'string' ? { command: stub.command } : {}) }
  }
}

/** Every task, or only those whose slug is in `filter` (an unknown slug is an error: a typo must not run nothing). */
export function loadTasks(filter: string[] = [], root: string = TASKS_ROOT): TaskSpec[] {
  const all = readdirSync(root).filter((name) => statSync(join(root, name)).isDirectory() && existsSync(join(root, name, 'task.json'))).sort()
  const unknown = filter.filter((slug) => !all.includes(slug))
  if (unknown.length) throw new Error(`Unknown task${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Known tasks: ${all.join(', ')}.`)
  return (filter.length ? all.filter((slug) => filter.includes(slug)) : all).map((slug) => loadTask(slug, root))
}
