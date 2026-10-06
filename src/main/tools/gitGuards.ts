import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { READ_FLAGS, runGit } from './gitRun'
import { resolveGitPath } from './gitPaths'

/**
 * Facts about a repository's own configuration that decide whether a tool may
 * look at its working tree without asking. A repository can be hostile (an
 * unpacked archive, a clone of someone else's project), and four of its settings
 * reach beyond what the workspace may read or run:
 *
 * - `filter.<name>.clean|smudge|process`: programs git runs to compare files, and
 *   nothing can switch them off. Reads that hash the working tree refuse.
 * - `core.worktree`: points git at another folder, so `git diff` or `git blame`
 *   would print files outside the workspace. A working tree that is not the folder
 *   holding the `.git` entry found from the workspace is refused. (A separate git
 *   directory sets core.worktree back to the same folder, which is accepted.)
 * - `blame.ignoreRevsFile`: git reads the file and repeats a line of it in its
 *   error, so a path outside the workspace refuses `git_blame`.
 * - textconv, external diff, fsmonitor and pagers are disabled by flags and by
 *   SAFE_GIT_ENV instead, so they need no check here.
 *
 * Settings from the user's own global or system config are trusted.
 */
export interface RepositoryFacts {
  /** filter.* keys in the repository's own config. */
  filters: string[]
  /** blame.ignoreRevsFile names a file that is not safely inside the workspace. */
  blameIgnoreFile: boolean
  /** The working tree git reports, when it is not the folder that holds the .git entry. */
  redirectedTo?: string
  /** The configuration could not be read in time, so nothing can be assumed. */
  unreadable: boolean
}

/** The nearest folder, from `start` upward, that contains a `.git` file or folder: where git discovers a repository. */
function folderHoldingGitEntry(start: string): string | undefined {
  let folder = start
  for (;;) {
    if (existsSync(join(folder, '.git'))) return folder
    const parent = dirname(folder)
    if (parent === folder) return undefined
    folder = parent
  }
}

const sameFolder = (a: string, b: string): boolean => relative(a, b) === ''

/** The value must stay inside the workspace even after links are resolved; `~` and `%(prefix)` are expanded by git. */
const ignoreFileIsSafe = (root: string, value: string): boolean =>
  !/^[~%]/.test(value) && resolveGitPath(root, value, 'blame.ignoreRevsFile').ok

export async function inspectRepository(root: string, signal?: AbortSignal): Promise<RepositoryFacts> {
  const run = (args: string[]) => runGit(root, [...READ_FLAGS, ...args], { readOnly: true, signal })
  const [local, worktree, top] = await Promise.all([
    run(['config', '--local', '--list', '-z', '--includes']),
    run(['config', '--worktree', '--list', '-z', '--includes']),
    run(['rev-parse', '--show-toplevel'])
  ])
  const facts: RepositoryFacts = { filters: [], blameIgnoreFile: false, unreadable: false }
  // Exit 128 is "not a repository" and a start error means git is missing: the real command reports both better.
  if (local.startError) return facts
  if (!local.ok && local.code !== 128) return { ...facts, unreadable: true }
  const filters = new Set<string>()
  // `--worktree` fails when several worktrees exist without the worktreeConfig extension; that scope is then empty.
  for (const scope of [local, worktree]) {
    if (!scope.ok) continue
    for (const entry of scope.stdout.split('\0')) {
      if (!entry) continue
      const newline = entry.indexOf('\n')
      const key = newline < 0 ? entry : entry.slice(0, newline)
      const value = newline < 0 ? '' : entry.slice(newline + 1)
      if (/^filter\./i.test(key)) filters.add(key)
      else if (key.toLowerCase() === 'blame.ignorerevsfile' && value && !ignoreFileIsSafe(root, value)) facts.blameIgnoreFile = true
    }
  }
  facts.filters = [...filters]
  if (top.ok) {
    const reported = top.stdout.trim()
    try {
      const expected = folderHoldingGitEntry(root)
      if (!expected || !sameFolder(realpathSync.native(reported), realpathSync.native(expected))) facts.redirectedTo = reported
    } catch { facts.redirectedTo = reported }
  }
  return facts
}

/** Why git must not read the working tree of this repository on its own, or undefined when it may. */
export function worktreeRefusal(facts: RepositoryFacts, what: string, options: { blame?: boolean } = {}): string | undefined {
  if (facts.unreadable) return `${what} is unavailable: the repository configuration could not be read in time.`
  if (facts.redirectedTo !== undefined) return redirectRefusal(facts, what)
  if (facts.filters.length) {
    return `${what} is unavailable here. This repository's own git config defines filter programs (${facts.filters.slice(0, 3).join(', ')}) that git would run to compare files, ` +
      'and Cubex only runs programs the user approved. git_log, git_show and git_diff with staged: true still work, and run_command asks the user before running git.'
  }
  if (options.blame && facts.blameIgnoreFile) {
    return `${what} is unavailable here. This repository's own git config sets blame.ignoreRevsFile to a file outside the workspace, and git would read it.`
  }
  return undefined
}

export function redirectRefusal(facts: RepositoryFacts, what: string): string {
  return `${what} is unavailable here. This repository's config points git at a different working tree (${facts.redirectedTo}) than the workspace, ` +
    'so reading it could expose files outside the workspace. git_log and git_show still work; the user can run anything else in a terminal.'
}
