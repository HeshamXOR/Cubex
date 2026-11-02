import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TaskSpec } from './types'

/** Folders that are not part of what an agent changed. */
const SKIP = new Set(['node_modules', '.git', '__pycache__', '.pytest_cache'])

export const fixtureDir = (task: TaskSpec): string => join(task.dir, 'fixture')
export const solutionDir = (task: TaskSpec): string => join(task.dir, 'solution')

/** A fresh copy of the task's fixture. */
export function copyFixture(task: TaskSpec, workspace: string): void {
  cpSync(fixtureDir(task), workspace, { recursive: true })
}

/** Copy the reference solution over a workspace (what the validation does; the stub provider writes the same files with tools). */
export function applySolution(task: TaskSpec, workspace: string): void {
  if (existsSync(solutionDir(task))) cpSync(solutionDir(task), workspace, { recursive: true })
}

/** Relative path (forward slashes) of every file under `root`. */
export function listFiles(root: string, dir = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const rel = dir ? `${dir}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...listFiles(root, rel))
    else if (entry.isFile() && !entry.name.endsWith('.pyc')) out.push(rel)
  }
  return out.sort()
}

/** Content hash of every file, by relative path. */
export function snapshot(root: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const rel of listFiles(root)) map.set(rel, createHash('sha1').update(readFileSync(join(root, rel))).digest('hex'))
  return map
}

/** Files added, changed or removed between two snapshots, each marked `+`, `~` or `-`, sorted by path. */
export function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const out: string[] = []
  for (const [rel, hash] of after) {
    if (!before.has(rel)) out.push(`+ ${rel}`)
    else if (before.get(rel) !== hash) out.push(`~ ${rel}`)
  }
  for (const rel of before.keys()) if (!after.has(rel)) out.push(`- ${rel}`)
  return out.sort((a, b) => a.slice(2).localeCompare(b.slice(2)))
}

/** Whether a program (`python` stands for python3 or python) starts on this machine. */
export function hasProgram(name: string): boolean {
  const names = name === 'python' ? ['python3', 'python'] : [name]
  return names.some((candidate) => {
    const result = spawnSync(candidate, ['--version'], { stdio: 'ignore', timeout: 10_000 })
    return !result.error && result.status === 0
  })
}
