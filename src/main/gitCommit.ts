import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionFileChange } from '@shared/ipc'
import { describeGitFailure, GIT_WRITE_TIMEOUT_MS, runGit, withRepoLock, type GitRun, type GitRunOptions } from './tools/gitRun'
import { gitWorkspace, resolveGitPaths, type Checked } from './tools/gitPaths'
import { parseStatus } from './tools/gitStatusParse'
import { inspectRepository, redirectRefusal } from './tools/gitGuards'

export const MAX_COMMIT_MESSAGE = 2000
export const MAX_COMMIT_PATHS = 200
/** Characters of file names per git call; Windows allows about 32 000 for a whole command line. */
const ARGUMENT_BUDGET = 16_000

const IDENTITY_HELP =
  'Git does not know who you are, so it cannot create a commit. Set your name and email, then try again:\n' +
  '  git config --global user.name "Your Name"\n' +
  '  git config --global user.email "you@example.com"\n' +
  'Leave out --global to set them for this repository only.'

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })
const ok = <T>(value: T): Checked<T> => ({ ok: true, value })

function checkMessage(message: unknown): Checked<string> {
  if (typeof message !== 'string' || !message.trim()) return fail('Enter a commit message.')
  if (message.length > MAX_COMMIT_MESSAGE) return fail(`The commit message is too long (the limit is ${MAX_COMMIT_MESSAGE} characters).`)
  if (message.includes('\0')) return fail('The commit message may not contain null characters.')
  return ok(message)
}

/**
 * Renderer input for gitCommit: an object with a message of 1 to 2000
 * characters and 1 to 200 path strings. Whether the paths stay inside the
 * workspace is decided later, against the real folder.
 */
export function parseGitCommitRequest(value: unknown): Checked<{ message: string; paths: string[] }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('The commit request is not valid.')
  const { message, paths } = value as { message?: unknown; paths?: unknown }
  const checked = checkMessage(message)
  if (!checked.ok) return checked
  if (!Array.isArray(paths) || paths.length === 0) return fail('Choose at least one file to commit.')
  if (paths.length > MAX_COMMIT_PATHS) return fail(`Too many files are selected (the limit is ${MAX_COMMIT_PATHS}).`)
  if (!paths.every((path) => typeof path === 'string' && path.length > 0 && path.length <= 4096 && !path.includes('\0'))) {
    return fail('Every path must be a workspace-relative file path.')
  }
  return ok({ message: checked.value, paths: paths as string[] })
}

export interface CommitFile {
  path: string
  /** Lines added and removed; null for a binary file. */
  added: number | null
  removed: number | null
}

export type CommitOutcome =
  | { ok: true; commit: string; branch?: string; subject: string; files: CommitFile[]; summary: string }
  | { ok: false; error: string }

export interface CommitRequest {
  message: unknown
  /** Workspace-relative files or folders to commit. Omitted: every tracked change under the workspace. */
  paths?: unknown
}

export interface CommitOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

/**
 * A path as a literal pathspec for a call that writes (see gitEnvironment): `file[1].txt`
 * must not also match `file1.txt`. Input paths never contain ":", so no magic can be smuggled in.
 */
const literal = (path: string): string => `:(literal)${path}`

/** Split file names into groups that fit one command line. */
function chunks(files: string[]): string[][] {
  const groups: string[][] = []
  let current: string[] = []
  let size = 0
  for (const file of files) {
    if (current.length && size + file.length + 1 > ARGUMENT_BUDGET) { groups.push(current); current = []; size = 0 }
    current.push(file)
    size += file.length + 1
  }
  if (current.length) groups.push(current)
  return groups
}

function parseShown(output: string): { commit: string; subject: string; files: CommitFile[] } {
  const lines = output.split('\n')
  const files: CommitFile[] = []
  for (const line of lines.slice(2)) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
    if (match) files.push({ path: match[3]!, added: match[1] === '-' ? null : Number(match[1]), removed: match[2] === '-' ? null : Number(match[2]) })
  }
  return { commit: (lines[0] ?? '').trim(), subject: (lines[1] ?? '').trim(), files }
}

function describeChange(files: CommitFile[]): string {
  const insertions = files.reduce((sum, file) => sum + (file.added ?? 0), 0)
  const deletions = files.reduce((sum, file) => sum + (file.removed ?? 0), 0)
  const parts = [`${files.length} file${files.length === 1 ? '' : 's'} changed`]
  if (insertions) parts.push(`${insertions} insertion${insertions === 1 ? '' : 's'}(+)`)
  if (deletions) parts.push(`${deletions} deletion${deletions === 1 ? '' : 's'}(-)`)
  return parts.join(', ')
}

/**
 * Commit the given paths and nothing else, or every tracked change under the
 * workspace when `paths` is omitted. Used by the review panel's Commit button and
 * by the model's git_commit tool.
 *
 * `git commit --only -- <paths>` takes the working-tree content of just those
 * paths and leaves the rest of the index alone, so whatever the user has staged
 * stays staged. It only knows tracked files, so a new file is first recorded with
 * `add --intent-to-add` (and un-recorded again if the commit fails). Never
 * `--no-verify`, `--amend` or `--allow-empty`: hooks run, history is only
 * appended to, and a commit with no changes is refused up front. The message goes
 * in over stdin and the paths come after `--`, so neither can become an option;
 * each path is passed as `:(literal)`, so it can never be a glob or other pathspec magic.
 */
export async function commitChanges(workspace: string | undefined, request: CommitRequest, options: CommitOptions = {}): Promise<CommitOutcome> {
  const message = checkMessage(request.message)
  if (!message.ok) return message
  const root = gitWorkspace(workspace)
  if (!root.ok) return root
  let paths: string[] | undefined
  if (request.paths !== undefined) {
    if (Array.isArray(request.paths) && request.paths.length === 0) return fail('Name at least one path, or leave paths out to commit every tracked change.')
    if (Array.isArray(request.paths) && request.paths.length > MAX_COMMIT_PATHS) return fail(`Too many paths (the limit is ${MAX_COMMIT_PATHS}).`)
    const resolved = resolveGitPaths(root.value, request.paths)
    if (!resolved.ok) return resolved
    if (resolved.value.join('').length + resolved.value.length > ARGUMENT_BUDGET + 4_000) return fail('The selected paths are too long to commit in one go. Select fewer files.')
    paths = resolved.value
  }
  return withRepoLock(root.value, () => commitLocked(root.value, message.value, paths, options))
}

/**
 * A git stopped by force (Windows has no gentler way) cannot remove the lock files it
 * held, and every later git command in the repository would fail until a person deleted
 * them. `next-index-<pid>.lock` is named after the process that created it, which proves
 * the commit also held index.lock, and an index.lock that dates from this commit's lifetime
 * is that lock. Anything else, such as another git's lock, is never touched.
 */
async function releaseLocksOfStoppedGit(root: string, pid: number | undefined, startedAt: number, stoppedAt: number): Promise<void> {
  const gitDir = await runGit(root, ['rev-parse', '--absolute-git-dir'], { readOnly: true })
  if (!gitDir.ok) return
  const folder = gitDir.stdout.trim()
  try {
    const entries = readdirSync(folder)
    for (const name of entries) {
      if (name === 'index.lock' || /^next-index-\d+\.lock$/.test(name)) {
        const file = join(folder, name)
        try {
          const mtime = statSync(file).mtimeMs
          if ((pid && name === `next-index-${pid}.lock`) || (mtime >= startedAt - 3_000 && mtime <= stoppedAt + 3_000)) {
            rmSync(file, { force: true })
          }
        } catch { /* lock file vanished or unreadable */ }
      }
    }
  } catch { /* folder read failed */ }
}

async function commitLocked(root: string, message: string, paths: string[] | undefined, options: CommitOptions): Promise<CommitOutcome> {
  const git = (args: string[], extra: GitRunOptions = {}): Promise<GitRun> =>
    runGit(root, ['--no-pager', '-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args], { signal: options.signal, ...extra })

  const inside = await git(['rev-parse', '--is-inside-work-tree'], { readOnly: true })
  if (!inside.ok) return fail(inside.code === 128 ? 'This folder is not inside a git repository.' : describeGitFailure(inside, 'rev-parse'))
  if (inside.stdout.trim() !== 'true') return fail('This folder is not inside a git working tree.')

  // git add and commit act on the working tree git reports: it must be this workspace's, never another folder's.
  const facts = await inspectRepository(root, options.signal)
  if (facts.unreadable) return fail('The repository configuration could not be read in time. Try again.')
  if (facts.redirectedTo !== undefined) return fail(redirectRefusal(facts, 'Committing'))

  // What is there to commit? Limited to the paths, or to the workspace folder when none were given.
  const scope = paths ?? ['.']
  // The write calls below name paths as :(literal); `.` is the workspace folder and needs no escaping.
  const writeScope = paths ? paths.map(literal) : scope
  const status = await git([
    'status', '--porcelain=v2', '-z', paths ? '--untracked-files=all' : '--untracked-files=no', '--ignore-submodules=all', '--', ...scope
  ], { readOnly: true })
  if (!status.ok) return fail(describeGitFailure(status, 'status'))
  // A cut-off listing would commit only some of a folder's new files without saying so.
  if (status.truncated) return fail('The selected paths contain too many changes to commit at once. Select fewer files.')
  const state = parseStatus(status.stdout)
  if (state.conflicts.length) return fail(`Resolve the merge conflicts before committing: ${state.conflicts.slice(0, 5).join(', ')}.`)
  if (!state.staged.length && !state.unstaged.length && !state.untracked.length) {
    return fail(paths
      ? 'Nothing to commit: the selected paths have no changes. (Files matched by .gitignore are never committed.)'
      : 'Nothing to commit: no tracked file has changes.')
  }

  // A listed path with no change must still be one git knows (tracked): `--only` rejects any other, ignored or
  // missing, and a clear answer here beats git's wording. A tracked file without changes is harmless.
  if (paths) {
    const touched = [...state.staged, ...state.unstaged].flatMap((change) => (change.from ? [change.path, change.from] : [change.path])).concat(state.untracked)
    const within = (candidate: string, path: string): boolean => candidate === path || candidate.startsWith(`${path}/`)
    const quiet = paths.filter((path) => !touched.some((candidate) => within(candidate, path)))
    if (quiet.length) {
      const known = await git(['ls-files', '-z', '--cached', '--', ...quiet], { readOnly: true })
      if (!known.ok) return fail(describeGitFailure(known, 'ls-files'))
      const tracked = known.stdout.split('\0').filter(Boolean)
      const unknown = quiet.filter((path) => !tracked.some((candidate) => within(candidate, path)))
      if (unknown.length) {
        const names = unknown.slice(0, 5).join(', ')
        return fail(`Cannot commit ${names}${unknown.length > 5 ? ' and more' : ''}: ${unknown.length === 1 ? 'it is' : 'they are'} not tracked by git and have no changes it can see. ` +
          'The file may be missing or ignored by .gitignore (ignored files are never committed).')
      }
    }
  }

  for (const variable of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    // user.useConfigOnly: use the configured identity, never one guessed from the user and host names.
    const identity = await git(['-c', 'user.useConfigOnly=true', 'var', variable], { readOnly: true })
    if (identity.startError || identity.timedOut || identity.aborted) return fail(describeGitFailure(identity, 'var'))
    if (!identity.ok) return fail(IDENTITY_HELP)
  }

  // A new file must be known to git before `--only` accepts it.
  const intent = paths ? state.untracked : []
  // Clean-up must run even after the caller cancelled, so it does not take the caller's signal.
  const unstage = async (): Promise<void> => {
    for (const part of chunks(intent)) await runGit(root, ['--no-pager', 'reset', '-q', '--', ...part.map(literal)])
  }
  for (const part of chunks(intent)) {
    const added = await git(['add', '--intent-to-add', '--', ...part.map(literal)])
    if (!added.ok) {
      await unstage()
      return fail(describeGitFailure(added, 'add'))
    }
  }

  const startedAt = Date.now()
  const committed = await git(
    ['-c', 'user.useConfigOnly=true', 'commit', '--only', '--file=-', '--cleanup=whitespace', '--', ...writeScope],
    { input: message, timeoutMs: options.timeoutMs ?? GIT_WRITE_TIMEOUT_MS }
  )
  const stoppedAt = Date.now()
  if (!committed.ok) {
    if (committed.timedOut || committed.aborted) await releaseLocksOfStoppedGit(root, committed.pid, startedAt, stoppedAt)
    await unstage()
    const detail = describeGitFailure(committed, 'commit')
    return fail(committed.timedOut || committed.aborted
      ? `${detail} A hook may have been running. If git later reports index.lock, make sure no git process is running and delete .git/index.lock.`
      : detail)
  }

  const shown = await git(['show', '--numstat', '--no-renames', '--no-ext-diff', '--no-textconv', '--format=%h%n%s', 'HEAD'], { readOnly: true })
  const info = parseShown(shown.ok ? shown.stdout : '')
  if (!info.commit) {
    const short = await git(['rev-parse', '--short', 'HEAD'], { readOnly: true })
    info.commit = short.ok ? short.stdout.trim() : ''
  }
  const branch = await git(['symbolic-ref', '--short', '-q', 'HEAD'], { readOnly: true })
  const subject = info.subject || (message.trim().split('\n', 1)[0] ?? '')
  return {
    ok: true,
    commit: info.commit,
    ...(branch.ok && branch.stdout.trim() ? { branch: branch.stdout.trim() } : {}),
    subject,
    files: info.files,
    summary: `${subject}\n${describeChange(info.files)}`
  }
}

// --- Suggested commit message ----------------------------------------------------------------------

const SUBJECT_LIMIT = 72
const VERBS = [['modified', 'Update'], ['added', 'Add'], ['deleted', 'Remove']] as const

/** The shortest trailing path (by whole segments) that tells each file apart from the others. */
function uniqueLabels(paths: string[]): Map<string, string> {
  const unique = [...new Set(paths)]
  const suffix = (path: string, depth: number): string => path.split('/').slice(-depth).join('/')
  const labels = new Map<string, string>()
  for (const path of unique) {
    const segments = path.split('/').length
    let depth = 1
    while (depth < segments && unique.some((other) => other !== path && suffix(other, depth) === suffix(path, depth))) depth++
    labels.set(path, suffix(path, depth))
  }
  return labels
}

const andList = (items: string[]): string =>
  items.length === 1 ? items[0]! : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

/**
 * A deterministic commit subject for the files a task changed, in the imperative
 * mood and at most 72 characters: "Update client.ts and add backoff.ts". Names are
 * used while they fit, then counts ("Update 12 files"). No model is involved.
 */
export function suggestCommitMessage(changes: ReadonlyArray<Pick<SessionFileChange, 'path' | 'status'>>): string {
  if (!changes.length) return ''
  const labels = uniqueLabels(changes.map((change) => change.path))
  const groups = VERBS.map(([status, verb]) => ({
    verb,
    names: changes.filter((change) => change.status === status).map((change) => change.path).sort().map((path) => labels.get(path)!)
  })).filter((group) => group.names.length > 0)
  const count = (names: string[]): string => `${names.length} file${names.length === 1 ? '' : 's'}`
  const build = (describe: (names: string[]) => string): string =>
    andList(groups.map((group, index) => `${index === 0 ? group.verb : group.verb.toLowerCase()} ${describe(group.names)}`))
  const attempts: Array<(names: string[]) => string> = [
    andList, // every name
    (names) => (names.length === 1 ? names[0]! : count(names)), // a count only where several files share a verb
    count // counts throughout
  ]
  for (const [index, describe] of attempts.entries()) {
    // One long file name is more useful truncated than as "Update 1 file".
    if (index === 2 && changes.length === 1) continue
    const subject = build(describe)
    if (subject.length <= SUBJECT_LIMIT) return subject
  }
  let cut = build(andList).slice(0, SUBJECT_LIMIT - 1)
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1) // do not split a surrogate pair
  return `${cut}…`
}
