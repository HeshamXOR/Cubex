import { spawn } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { WorkspaceGitStatus } from '@shared/ipc'
import { childEnvironment } from './childEnv'
import { shadowedByWorkspace } from './tools/shellReadOnly'

const GIT_TIMEOUT_MS = 3_000
const CACHE_MS = 2_000
const MAX_CACHED = 32
const MAX_KEPT_OUTPUT = 64 * 1024
/**
 * Repository-local filter drivers run programs while `git status` hashes
 * changed files, and they cannot be switched off generically. A folder opened in
 * Cubex is polled without any consent step, so a repository that defines one
 * only gets branch facts. fsmonitor is disabled by SAFE_GIT_ENV, and submodules
 * (with their own configs) are never entered.
 */
const STATUS_RUNS_PROGRAMS = /^filter\./i

interface GitOutput {
  code: number | null
  /** The first MAX_KEPT_OUTPUT bytes of stdout. */
  stdout: string
  /** Newline count over the whole stdout, including bytes not kept. */
  lines: number
}

const notARepo = (): WorkspaceGitStatus => ({ isRepo: false, changedFiles: 0 })
const cacheKey = (path: string): string => (process.platform === 'win32' ? path.toLowerCase() : path)

/** Branch facts from the `## …` line of `git status --porcelain=v1 --branch`. */
export function parseStatusHeader(line: string): Pick<WorkspaceGitStatus, 'branch' | 'ahead' | 'behind'> {
  const text = line.replace(/^## /, '').trim()
  const unborn = /^(?:No commits yet on|Initial commit on) (.+)$/.exec(text)
  if (unborn) return { branch: unborn[1] }
  if (!text || text.startsWith('HEAD (no branch)')) return {}
  // Ref names cannot contain "..", so the first "..." separates the upstream.
  const match = /^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(text)
  if (!match) return {}
  const [, branch, upstream, track = ''] = match
  if (!upstream || track === 'gone') return { branch }
  const count = (word: string): number => Number(new RegExp(`${word} (\\d+)`).exec(track)?.[1] ?? 0)
  return { branch, ahead: count('ahead'), behind: count('behind') }
}

/** Run git directly (no shell) with the hardened child environment. Never rejects. */
function runGit(args: string[], cwd: string): Promise<GitOutput> {
  const env: NodeJS.ProcessEnv = { ...childEnvironment(), GIT_OPTIONAL_LOCKS: '0' }
  // An inherited repository override would point git at a different repository.
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[name]
  return new Promise((resolvePromise) => {
    const failed: GitOutput = { code: null, stdout: '', lines: 0 }
    let child
    try {
      child = spawn('git', args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_TIMEOUT_MS })
    } catch { return resolvePromise(failed) }
    const kept: Buffer[] = []
    let keptBytes = 0
    let lines = 0
    child.stdout.on('data', (chunk: Buffer) => {
      for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, index + 1)) lines++
      if (keptBytes < MAX_KEPT_OUTPUT) {
        const part = chunk.subarray(0, MAX_KEPT_OUTPUT - keptBytes)
        kept.push(part)
        keptBytes += part.length
      }
    })
    child.on('error', () => resolvePromise(failed))
    child.on('close', (code) => resolvePromise({ code, stdout: Buffer.concat(kept).toString('utf8'), lines }))
  })
}

async function probe(root: string): Promise<WorkspaceGitStatus> {
  // A workspace-planted git.exe/git.bat must never run in place of the real one.
  if (shadowedByWorkspace('git', root)) return notARepo()
  const head = runGit(['rev-parse', '--short', 'HEAD'], root).then((out) => (out.code === 0 ? out.stdout.trim() : ''))
  const [local, worktree] = await Promise.all([
    runGit(['config', '--local', '--list', '--name-only', '--includes'], root),
    runGit(['config', '--worktree', '--list', '--name-only', '--includes'], root)
  ])
  // Also fails outside a repository and when git is missing.
  if (local.code !== 0) return notARepo()
  const keys = `${local.stdout}\n${worktree.code === 0 ? worktree.stdout : ''}`.split(/\r?\n/)
  const unsafe = keys.some((key) => STATUS_RUNS_PROGRAMS.test(key.trim()))
  const [shortHead, out] = await Promise.all([
    head,
    unsafe ? undefined : runGit(['status', '--porcelain=v1', '--branch', '--ignore-submodules=all'], root)
  ])
  const facts = shortHead ? { head: shortHead } : {}
  if (out?.code === 0) {
    const header = out.stdout.split('\n', 1)[0] ?? ''
    return { isRepo: true, ...parseStatusHeader(header), ...facts, changedFiles: Math.max(0, out.lines - 1) }
  }
  // A program-running config, or a status that failed or hit the timeout in a huge
  // tree: it is still a repository, so report the branch without a change count.
  const symbolic = await runGit(['symbolic-ref', '--short', '-q', 'HEAD'], root)
  const branch = symbolic.code === 0 ? symbolic.stdout.trim() : ''
  return { isRepo: true, ...(branch ? { branch } : {}), ...facts, changedFiles: 0, changedFilesUnknown: true }
}

/**
 * Read-only git facts for a workspace (title-bar branch chip, review panel).
 * Each workspace is probed at most once per CACHE_MS; concurrent callers share
 * the in-flight probe.
 */
export class GitStatusReader {
  private readonly cache = new Map<string, { settledAt: number; status: Promise<WorkspaceGitStatus> }>()

  constructor(private readonly ttlMs = CACHE_MS) {}

  /** Null when there is no workspace; a missing folder or non-repository is `isRepo: false`. */
  async read(workspace: string | undefined): Promise<WorkspaceGitStatus | null> {
    if (!workspace) return null
    let root: string
    try {
      root = realpathSync.native(resolve(workspace))
      if (!lstatSync(root).isDirectory()) return notARepo()
    } catch { return notARepo() }
    const now = Date.now()
    for (const [key, entry] of this.cache) if (now - entry.settledAt > this.ttlMs) this.cache.delete(key)
    const key = cacheKey(root)
    const cached = this.cache.get(key)
    if (cached) return { ...(await cached.status) }
    // Pending probes never expire; the TTL starts once the probe settles.
    const entry = { settledAt: Number.POSITIVE_INFINITY, status: probe(root) }
    this.cache.set(key, entry)
    if (this.cache.size > MAX_CACHED) this.cache.delete(this.cache.keys().next().value!)
    try { return { ...(await entry.status) } }
    finally { entry.settledAt = Date.now() }
  }
}
