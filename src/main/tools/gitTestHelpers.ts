import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Test-only helpers for building throwaway repositories. Not imported by the app. */
export const hasGit = spawnSync('git', ['--version'], { windowsHide: true }).status === 0

export const posix = (path: string): string => path.replace(/\\/g, '/')

/** Run git in a test repository with an identity and no signing, whatever the developer's global config says. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [
    '-c', 'user.name=Cubex Test', '-c', 'user.email=cubex@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args
  ], { cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

export function write(dir: string, file: string, content: string): void {
  const path = join(dir, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

/** A repository on branch "trunk" whose identity lives in its own config (unless `identity` is false). */
export function initRepo(dir: string, identity = true): void {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/trunk')
  const settings: Array<readonly [string, string]> = [['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]
  if (identity) settings.push(['user.name', 'Cubex Test'], ['user.email', 'cubex@example.invalid'])
  for (const [key, value] of settings) git(dir, 'config', key, value)
}

/** Two commits: a.txt and sub/b.txt, then a third line added to a.txt. */
export function seedHistory(dir: string): void {
  write(dir, 'a.txt', 'one\ntwo\n')
  write(dir, 'sub/b.txt', 'bee\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'Add files')
  write(dir, 'a.txt', 'one\ntwo\nthree\n')
  git(dir, 'commit', '-q', '-am', 'Add a third line')
}

/** Install a hook script and point git at it, even when global config sets core.hooksPath. */
export function writeHook(dir: string, name: string, body: string): void {
  const hooks = join(dir, '.git', 'hooks')
  mkdirSync(hooks, { recursive: true })
  const file = join(hooks, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  git(dir, 'config', 'core.hooksPath', posix(hooks))
}

/**
 * A script that records each run in ran.txt next to it and then copies stdin to
 * stdout. Used as a stand-in for fsmonitor, textconv and filter programs.
 */
export function writeProbe(dir: string): { script: string; ran: string } {
  const script = join(dir, 'probe.sh')
  writeFileSync(script, '#!/bin/sh\necho ran >> "$(dirname "$0")/ran.txt"\ncat\n')
  chmodSync(script, 0o755)
  return { script: posix(script), ran: join(dir, 'ran.txt') }
}

/** Create `count` empty commits on trunk in one process (a fresh repository). */
export function fastImportCommits(dir: string, count: number): void {
  const lines: string[] = []
  for (let index = 1; index <= count; index++) {
    const message = `commit number ${index}`
    lines.push('commit refs/heads/trunk', `committer Cubex Test <cubex@example.invalid> ${1_700_000_000 + index} +0000`,
      `data ${Buffer.byteLength(message)}`, message, '')
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: dir, input: lines.join('\n'), windowsHide: true })
}

/** The `git status --porcelain` lines of a repository, for asserting what a commit left behind. */
export function porcelain(dir: string): string[] {
  return git(dir, '-c', 'core.quotepath=false', 'status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean).sort()
}

/** The paths a commit changed, sorted. */
export function committedPaths(dir: string, rev = 'HEAD'): string[] {
  return git(dir, '-c', 'core.quotepath=false', 'show', '--name-only', '--format=', '--no-renames', rev).split('\n').filter(Boolean).sort()
}

export const commitCount = (dir: string): number => Number(git(dir, 'rev-list', '--count', 'HEAD').trim())
