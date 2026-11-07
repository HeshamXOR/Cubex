import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { nanoid } from 'nanoid'
import type { ConversationWorktree, WorktreePlan, WorktreeSummary } from '@shared/ipc'
import { GIT_WRITE_TIMEOUT_MS, runGit, type GitRun } from './tools/gitRun'
import { isProtectedPath } from './tools/workspacePaths'

/**
 * A task can work in a checkout of its own: a git worktree on a new branch, kept outside the project. Several tasks can then
 * change the same files at once, and the project folder stays as it was until the person brings a result back.
 */

/** Where every worktree lives. A short path, because Windows and node_modules do not get along with long ones. */
export function worktreesRoot(): string {
  return join(homedir(), '.cubex', 'worktrees')
}

/** A project's file saying how to set up a new worktree. */
const SETUP_FILE = join('.cubex', 'worktrees.json')
const MAX_SETUP_COMMANDS = 8
const MAX_COPIES = 32
const WORKTREE_ID = /^[A-Za-z0-9_-]{4,32}$/

/** Hooks are the project's own programs, and creating a checkout should not start any. */
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null']

function failureOf(run: GitRun, fallback: string): string {
  const said = run.stderr.trim().split('\n').filter((line) => !/^hint:/i.test(line)).slice(0, 4).join('\n')
  return said || fallback
}

async function git(cwd: string, args: string[], timeoutMs = GIT_WRITE_TIMEOUT_MS, input?: string, indexFile?: string): Promise<GitRun> {
  return runGit(cwd, args, { timeoutMs, ...(input !== undefined ? { input } : {}), ...(indexFile ? { indexFile } : {}) })
}

/** The folder as git sees it: its real path. */
function realFolder(path: string): string {
  try { return realpathSync.native(path) } catch { return resolve(path) }
}

interface SetupFile {
  setup: string[]
  copy: string[]
}

function readSetupFile(repoRoot: string): SetupFile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(repoRoot, SETUP_FILE), 'utf8')) as { setup?: unknown; copy?: unknown } | null
    const strings = (value: unknown, limit: number): string[] => (Array.isArray(value) ? value : [])
      .filter((entry): entry is string => typeof entry === 'string' && !!entry.trim() && entry.length <= 2_000).slice(0, limit)
    return { setup: strings(parsed?.setup, MAX_SETUP_COMMANDS), copy: strings(parsed?.copy, MAX_COPIES) }
  } catch {
    return undefined
  }
}

/** What a checkout of this project most likely needs before its tests can run. Only ever a suggestion the person sees. */
export function detectSetup(repoRoot: string): string[] {
  const has = (name: string): boolean => existsSync(join(repoRoot, name))
  if (has('pnpm-lock.yaml')) return ['pnpm install --frozen-lockfile']
  if (has('yarn.lock')) return ['yarn install --frozen-lockfile']
  if (has('bun.lockb') || has('bun.lock')) return ['bun install --frozen-lockfile']
  if (has('package-lock.json')) return ['npm ci']
  if (has('package.json')) return ['npm install']
  if (has('uv.lock')) return ['uv sync']
  if (has('poetry.lock')) return ['poetry install']
  if (has('requirements.txt')) return ['pip install -r requirements.txt']
  if (has('Cargo.lock')) return ['cargo fetch']
  if (has('go.sum')) return ['go mod download']
  return []
}

/** What creating a worktree would do, for the person to read first. It changes nothing. */
export async function planWorktree(workspace: string): Promise<WorktreePlan> {
  const top = await git(workspace, ['rev-parse', '--show-toplevel'], 15_000)
  if (!top.ok) return { ok: false, reason: 'This folder is not a git repository, so it cannot have worktrees.' }
  // In the spelling the person's own folder uses, not git's, so a task in a worktree groups with the project's other tasks.
  const repoRoot = resolve(workspace, relative(realFolder(workspace), realFolder(top.stdout.trim())))
  const head = await git(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD'], 15_000)
  if (!head.ok) return { ok: false, reason: 'This repository has no commits yet. Make a first commit, then try again.' }
  const branch = await git(repoRoot, ['symbolic-ref', '--short', '-q', 'HEAD'], 15_000)
  const status = await git(repoRoot, ['status', '--porcelain=v1', '--ignore-submodules=all'], 30_000)
  const file = readSetupFile(repoRoot)
  return {
    ok: true,
    repoRoot,
    branch: branch.ok ? branch.stdout.trim() : head.stdout.trim().slice(0, 8),
    uncommitted: status.ok ? status.stdout.split('\n').filter(Boolean).length : 0,
    setup: file?.setup ?? detectSetup(repoRoot),
    copy: file?.copy ?? [],
    setupFromProject: !!file
  }
}

function slugOf(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'task'
}

/** Git would read a leading dash as an option, and a few names are not allowed in a branch. */
function folderFor(repoRoot: string, id: string): string {
  const hash = createHash('sha256').update(process.platform === 'win32' ? repoRoot.toLowerCase() : repoRoot).digest('hex').slice(0, 8)
  return join(worktreesRoot(), `${slugOf(basename(repoRoot))}-${hash}`, id)
}

/** Copy the files the person listed (say, an .env), which git does not carry over. Returns what could not be copied. */
export function copyIntoWorktree(repoRoot: string, target: string, files: readonly string[]): string[] {
  const failed: string[] = []
  for (const file of files.slice(0, MAX_COPIES)) {
    const from = resolve(repoRoot, file)
    const path = relative(repoRoot, from)
    if (!path || isAbsolute(file) || path === '..' || path.startsWith(`..${sep}`) || isProtectedPath(path)) { failed.push(file); continue }
    try {
      // A link could lead anywhere, so only plain files come along.
      if (!lstatSync(from).isFile()) { failed.push(file); continue }
      const to = join(target, path)
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
    } catch {
      failed.push(file)
    }
  }
  return failed
}

export interface CreateWorktreeOptions {
  workspace: string
  title?: string
  copy?: readonly string[]
  raceId?: string
}

export type Created = { ok: true; worktree: ConversationWorktree; workspacePath: string; copyFailed: string[] } | { ok: false; reason: string }

/** A new branch from the commit the project is on, checked out in a folder of its own. */
export async function createWorktree(options: CreateWorktreeOptions): Promise<Created> {
  const plan = await planWorktree(options.workspace)
  if (!plan.ok) return plan
  const repoRoot = plan.repoRoot
  const baseCommit = await git(repoRoot, ['rev-parse', 'HEAD'], 15_000)
  if (!baseCommit.ok) return { ok: false, reason: failureOf(baseCommit, 'Could not read the current commit.') }
  // Worktrees whose folders were deleted by hand would otherwise keep their branches checked out for ever.
  await git(repoRoot, ['worktree', 'prune'], 15_000)
  const id = nanoid(8).replace(/^[-_]+/, 'w')
  const path = folderFor(repoRoot, id)
  const branch = `cubex/${slugOf(options.title ?? 'task')}-${id.toLowerCase().replace(/[^a-z0-9]/g, 'x')}`
  mkdirSync(dirname(path), { recursive: true })
  const added = await git(repoRoot, [...NO_HOOKS, 'worktree', 'add', '-q', '-b', branch, path, baseCommit.stdout.trim()])
  if (!added.ok) return { ok: false, reason: failureOf(added, 'Git could not create the worktree.') }
  const worktree: ConversationWorktree = {
    repoRoot, path, branch, baseCommit: baseCommit.stdout.trim(), baseBranch: plan.branch, createdAt: Date.now(),
    ...(options.raceId ? { raceId: options.raceId } : {})
  }
  // A task opened in a subfolder of the project stays in that subfolder.
  const within = relative(repoRoot, resolve(options.workspace))
  const workspacePath = within && !within.startsWith('..') && !isAbsolute(within) ? join(path, within) : path
  const copyFailed = copyIntoWorktree(repoRoot, path, options.copy ?? [])
  return { ok: true, worktree: await withBaseline(worktree), workspacePath, copyFailed }
}

/**
 * The whole folder as a git tree, tracked and untracked files alike, without staging anything: the agent's own index is not
 * touched, even if it is running in that folder right now. What .gitignore leaves out stays out.
 */
async function snapshotTree(worktree: ConversationWorktree): Promise<string | undefined> {
  const scratch = mkdtempSync(join(tmpdir(), 'cubex-index-'))
  const index = join(scratch, 'index')
  try {
    // Starting from the real index means git only has to read the files that changed.
    const real = await git(worktree.path, ['rev-parse', '--git-path', 'index'], 15_000)
    const source = real.ok ? resolve(worktree.path, real.stdout.trim()) : ''
    if (source && existsSync(source)) copyFileSync(source, index)
    else if (!(await git(worktree.path, ['read-tree', 'HEAD'], 30_000, undefined, index)).ok) return undefined
    if (!(await git(worktree.path, ['add', '-A', '--', '.'], GIT_WRITE_TIMEOUT_MS, undefined, index)).ok) return undefined
    const tree = await git(worktree.path, ['write-tree'], 60_000, undefined, index)
    return tree.ok ? tree.stdout.trim() : undefined
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

const baselineRef = (worktree: ConversationWorktree): string => `refs/cubex/baseline/${basename(worktree.path)}`

/**
 * Where the task's own work starts from: after the files copied in and the setup commands, so that a lockfile written by
 * `npm install` is not taken for something the model did. A ref keeps git from tidying the tree away.
 */
export async function withBaseline(worktree: ConversationWorktree): Promise<ConversationWorktree> {
  const tree = await snapshotTree(worktree)
  if (!tree) return worktree
  await git(worktree.path, ['update-ref', baselineRef(worktree), tree], 15_000)
  return { ...worktree, baseTree: tree }
}

/** What the task's changes are measured against. */
const baseOf = (worktree: ConversationWorktree): string => worktree.baseTree ?? worktree.baseCommit

/** Never trust a stored path further than this: only a folder under our root, that git itself says is one of this project's worktrees. */
async function verified(worktree: ConversationWorktree): Promise<boolean> {
  const root = worktreesRoot()
  const within = relative(root, resolve(worktree.path))
  if (!within || within.startsWith('..') || isAbsolute(within)) return false
  if (!WORKTREE_ID.test(basename(worktree.path))) return false
  const list = await git(worktree.repoRoot, ['worktree', 'list', '--porcelain'], 15_000)
  if (!list.ok) return false
  const canonical = (path: string): string => {
    let real = resolve(path)
    try { real = realpathSync.native(path) } catch { /* the folder may be gone */ }
    return process.platform === 'win32' ? real.toLowerCase() : real
  }
  const wanted = canonical(worktree.path)
  return list.stdout.split('\n').some((line) => line.startsWith('worktree ') && canonical(line.slice('worktree '.length).trim()) === wanted)
}

/** How far this worktree has come from where it started. */
export async function summarizeWorktree(worktree: ConversationWorktree): Promise<WorktreeSummary> {
  if (!existsSync(worktree.path)) return { exists: false, files: 0, additions: 0, deletions: 0, commits: 0 }
  const now = await snapshotTree(worktree)
  if (!now) return { exists: true, files: 0, additions: 0, deletions: 0, commits: 0 }
  const numstat = await git(worktree.path, ['diff', '--numstat', baseOf(worktree), now], 30_000)
  const commits = await git(worktree.path, ['rev-list', '--count', `${worktree.baseCommit}..HEAD`], 15_000)
  let files = 0
  let additions = 0
  let deletions = 0
  for (const line of numstat.stdout.split('\n')) {
    const [added, removed] = line.split('\t')
    if (added === undefined || removed === undefined) continue
    files++
    additions += Number(added) || 0
    deletions += Number(removed) || 0
  }
  return { exists: true, files, additions, deletions, commits: Number(commits.stdout.trim()) || 0 }
}

/** The whole change as a patch, for reading. */
export async function worktreeDiff(worktree: ConversationWorktree): Promise<string> {
  if (!existsSync(worktree.path)) return ''
  const now = await snapshotTree(worktree)
  if (!now) return ''
  const diff = await git(worktree.path, ['diff', baseOf(worktree), now], 30_000)
  return diff.stdout
}

export type ApplyResult = { ok: true; files: number } | { ok: false; reason: string }

/**
 * Bring the worktree's change into the project folder as uncommitted edits, where the person reviews them as usual. All or nothing:
 * if any of it does not fit what is there now, nothing is touched and the branch is still there to merge by hand.
 */
export async function applyWorktree(worktree: ConversationWorktree): Promise<ApplyResult> {
  if (!(await verified(worktree))) return { ok: false, reason: 'This worktree is not one Cubex created for this project any more.' }
  const now = await snapshotTree(worktree)
  if (!now) return { ok: false, reason: 'Could not read the changes in the worktree.' }
  const patch = await git(worktree.path, ['diff', '--binary', '--full-index', baseOf(worktree), now], 60_000)
  if (!patch.ok) return { ok: false, reason: failureOf(patch, 'Could not read the changes in the worktree.') }
  if (patch.truncated) return { ok: false, reason: `This change is too large to apply here. Merge the branch ${worktree.branch} instead.` }
  if (!patch.stdout.trim()) return { ok: false, reason: 'This worktree has no changes to apply.' }
  const check = await git(worktree.repoRoot, ['apply', '--check', '--whitespace=nowarn', '-'], 60_000, patch.stdout)
  if (!check.ok) {
    return { ok: false, reason: `The change does not fit the project folder as it is now, so nothing was changed. Merge the branch ${worktree.branch} by hand, or commit or undo what is in the way.\n${failureOf(check, '')}`.trim() }
  }
  const applied = await git(worktree.repoRoot, ['apply', '--whitespace=nowarn', '-'], 60_000, patch.stdout)
  if (!applied.ok) return { ok: false, reason: failureOf(applied, 'Git could not apply the change.') }
  const files = patch.stdout.split('\n').filter((line) => line.startsWith('diff --git ')).length
  return { ok: true, files }
}

export type RemoveResult = { ok: true } | { ok: false; reason: string }

/** Delete the worktree and its branch, with whatever is in them. */
export async function removeWorktree(worktree: ConversationWorktree): Promise<RemoveResult> {
  if (!(await verified(worktree))) {
    // Already gone: its folder was deleted by hand, and prune has dropped it. Only the branch may be left.
    if (existsSync(worktree.path)) return { ok: false, reason: 'This folder is not a worktree Cubex created for this project, so it was left alone.' }
    await git(worktree.repoRoot, ['worktree', 'prune'], 15_000)
    if (worktree.branch.startsWith('cubex/')) await git(worktree.repoRoot, ['branch', '-D', worktree.branch], 15_000)
    return { ok: true }
  }
  const removed = await git(worktree.repoRoot, [...NO_HOOKS, 'worktree', 'remove', '--force', worktree.path])
  if (!removed.ok) return { ok: false, reason: `${failureOf(removed, 'Git could not remove the worktree.')} A running program may still be using it.` }
  await git(worktree.repoRoot, ['update-ref', '-d', baselineRef(worktree)], 15_000)
  if (worktree.branch.startsWith('cubex/')) await git(worktree.repoRoot, ['branch', '-D', worktree.branch], 15_000)
  return { ok: true }
}
