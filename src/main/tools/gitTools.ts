import type { ExecutableTool, JSONValue, ToolExecutionContext, ToolResult } from '@core/types'
import { commitChanges, MAX_COMMIT_MESSAGE, MAX_COMMIT_PATHS, type CommitOutcome } from '../gitCommit'
import { clipOutput, describeGitFailure, GIT_WRITE_TIMEOUT_MS, READ_FLAGS, runGit, withRepoLock, type GitRun, type GitRunOptions } from './gitRun'
import { inspectRepository, worktreeRefusal } from './gitGuards'
import { gitWorkspace, resolveGitPath, validateRevision, type Checked } from './gitPaths'
import { parseStatus, type ParsedStatus, type StatusChange } from './gitStatusParse'

/** Most entries listed per group in a status summary. */
const MAX_LISTED = 100
const DEFAULT_LOG = 20
const MAX_LOG = 50

const failed = (content: string): ToolResult => ({ toolUseId: '', content, isError: true })
const succeeded = (content: string): ToolResult => ({ toolUseId: '', content, isError: false })

type Fields = Record<string, JSONValue>

/** The tool input as an object; missing input is an empty object, anything else that is not an object is an error. */
function fieldsOf(input: JSONValue | undefined, tool: string): Checked<Fields> {
  if (input === undefined || input === null) return { ok: true, value: {} }
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: `${tool} requires an object of named arguments.` }
  return { ok: true, value: input }
}

/** JSON null counts as "not given": models often send it for optional arguments. */
const given = (value: JSONValue | undefined): JSONValue | undefined => (value === null ? undefined : value)

function optionalPath(root: string, value: JSONValue | undefined): Checked<string | undefined> {
  const path = given(value)
  if (path === undefined) return { ok: true, value: undefined }
  const checked = resolveGitPath(root, path, 'path')
  // The workspace folder itself means "no filter".
  return checked.ok ? { ok: true, value: checked.value || undefined } : checked
}

function optionalLine(value: JSONValue | undefined, label: string): Checked<number | undefined> {
  const line = given(value)
  if (line === undefined) return { ok: true, value: undefined }
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) return { ok: false, error: `${label} must be a whole number of 1 or more.` }
  return { ok: true, value: line }
}

const readGit = (root: string, args: string[], signal: AbortSignal | undefined): Promise<GitRun> =>
  runGit(root, [...READ_FLAGS, ...args], { readOnly: true, signal })

// --- git_status ------------------------------------------------------------------------------

function branchLine(status: ParsedStatus): string {
  let line: string
  if (status.head === undefined) line = 'Branch unknown'
  else if (status.head === '(detached)') line = `HEAD detached at ${status.oid && status.oid !== '(initial)' ? status.oid.slice(0, 7) : 'an unknown commit'}`
  else if (status.oid === '(initial)') line = `On branch ${status.head}. No commits yet on ${status.head}`
  else line = `On branch ${status.head}`
  if (status.upstream) {
    line += `, tracking ${status.upstream}`
    line += status.ahead === undefined ? ' (upstream is gone)' : ` (ahead ${status.ahead}, behind ${status.behind ?? 0})`
  }
  return line
}

function formatStatus(status: ParsedStatus): string {
  const lines = [branchLine(status)]
  const group = (title: string, entries: string[]): void => {
    if (!entries.length) return
    lines.push(`${title} (${entries.length}):`)
    for (const entry of entries.slice(0, MAX_LISTED)) lines.push(`  ${entry}`)
    if (entries.length > MAX_LISTED) lines.push(`  … and ${entries.length - MAX_LISTED} more`)
  }
  const describe = (change: StatusChange): string => `${change.word.padEnd(14)}${change.from ? `${change.from} -> ${change.path}` : change.path}`
  group('Merge conflicts', status.conflicts)
  group('Staged changes', status.staged.map(describe))
  group('Unstaged changes', status.unstaged.map(describe))
  group('Untracked files', status.untracked)
  if (!status.conflicts.length && !status.staged.length && !status.unstaged.length && !status.untracked.length) lines.push('Working tree clean.')
  return lines.join('\n')
}

async function branchOnly(root: string, refusal: string, signal: AbortSignal | undefined): Promise<string> {
  const symbolic = await readGit(root, ['symbolic-ref', '--short', '-q', 'HEAD'], signal)
  const head = symbolic.ok ? symbolic.stdout.trim() : ''
  const detached = head ? undefined : await readGit(root, ['rev-parse', '--short', 'HEAD'], signal)
  const where = head ? `On branch ${head}` : detached?.ok ? `HEAD detached at ${detached.stdout.trim()}` : 'Branch unknown'
  return `${where}\nThe list of changed files was skipped. ${refusal}`
}

function statusTool(workspace: string): ExecutableTool {
  return {
    definition: {
      name: 'git_status',
      description:
        'Show the git state of the workspace: the current branch and upstream (ahead/behind), and which files are staged, modified, untracked or in conflict. ' +
        'Read-only and safe to call whenever you need to know what is changed. Use it before git_commit.',
      inputSchema: { type: 'object', properties: {} }
    },
    defaultPermission: 'allow',
    async execute(_input: JSONValue, ctx: ToolExecutionContext): Promise<ToolResult> {
      const root = gitWorkspace(workspace)
      if (!root.ok) return failed(root.error)
      const refusal = worktreeRefusal(await inspectRepository(root.value, ctx?.signal), 'git_status')
      if (refusal) return succeeded(await branchOnly(root.value, refusal, ctx?.signal))
      const run = await readGit(root.value,
        ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal', '--ignore-submodules=all'], ctx?.signal)
      if (!run.ok) return failed(describeGitFailure(run, 'status'))
      const summary = formatStatus(parseStatus(run.stdout))
      // A listing cut off at the capture limit must not read as the whole picture.
      return succeeded(run.truncated ? `${summary}\n… [the change list was cut off because it is very long; it is incomplete]` : summary)
    }
  }
}

// --- git_diff, git_log, git_show, git_blame ----------------------------------------------------------

/** Output a model can read: text, clipped, with a clear answer for nothing and for binary data. */
function present(run: GitRun, what: string, empty: string): ToolResult {
  if (!run.ok) return failed(describeGitFailure(run, what))
  if (run.stdout.includes('\0')) return failed(`git ${what} produced binary data, which is not shown.`)
  return succeeded(run.stdout.trim() ? clipOutput(run.stdout, run.truncated) : empty)
}

function diffTool(workspace: string): ExecutableTool {
  return {
    definition: {
      name: 'git_diff',
      description:
        'Show changes as a diffstat followed by a unified diff. By default this is the unstaged changes (working tree against the index); ' +
        'staged: true shows what is staged for the next commit; base compares against a revision such as main or HEAD~3 (the working tree, or the index when staged). ' +
        'Untracked files are not part of a diff, use git_status to see them. Output is capped near 60 KB: pass path to narrow it to a file or folder.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file or folder to limit the diff to.' },
          staged: { type: 'boolean', description: 'Show the staged (index) changes instead of the unstaged ones.' },
          base: { type: 'string', description: 'A revision to compare against, for example main, HEAD~2 or a tag.' }
        }
      }
    },
    defaultPermission: 'allow',
    async execute(input: JSONValue, ctx: ToolExecutionContext): Promise<ToolResult> {
      const fields = fieldsOf(input, 'git_diff')
      if (!fields.ok) return failed(fields.error)
      const root = gitWorkspace(workspace)
      if (!root.ok) return failed(root.error)
      const staged = given(fields.value.staged)
      if (staged !== undefined && typeof staged !== 'boolean') return failed('staged must be true or false.')
      const path = optionalPath(root.value, fields.value.path)
      if (!path.ok) return failed(path.error)
      const baseInput = given(fields.value.base)
      const base = baseInput === undefined ? undefined : validateRevision(baseInput, 'base')
      if (base && !base.ok) return failed(base.error)
      // Anything that compares the working tree reads files: a repository can make that run its filter programs or read elsewhere.
      if (!staged) {
        const refusal = worktreeRefusal(await inspectRepository(root.value, ctx?.signal), 'git_diff for working-tree changes')
        if (refusal) return failed(refusal)
      }
      const run = await readGit(root.value, [
        'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--no-color', '--stat', '--patch',
        ...(staged ? ['--cached'] : []), ...(base ? [base.value] : []), ...(path.value ? ['--', path.value] : [])
      ], ctx?.signal)
      return present(run, 'diff', staged ? 'No staged changes.' : 'No unstaged changes (untracked files are not part of a diff; see git_status).')
    }
  }
}

function logTool(workspace: string): ExecutableTool {
  return {
    definition: {
      name: 'git_log',
      description:
        `List recent commits on the current branch, newest first: short hash, date, author and subject. max is 1 to ${MAX_LOG} (default ${DEFAULT_LOG}). ` +
        'Pass path to list only the commits that touched that file or folder. Use git_show for the details of one commit.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file or folder; only commits that touched it are listed.' },
          max: { type: 'integer', description: `How many commits to list, 1 to ${MAX_LOG}. Default ${DEFAULT_LOG}.` }
        }
      }
    },
    defaultPermission: 'allow',
    async execute(input: JSONValue, ctx: ToolExecutionContext): Promise<ToolResult> {
      const fields = fieldsOf(input, 'git_log')
      if (!fields.ok) return failed(fields.error)
      const root = gitWorkspace(workspace)
      if (!root.ok) return failed(root.error)
      const path = optionalPath(root.value, fields.value.path)
      if (!path.ok) return failed(path.error)
      const maxInput = given(fields.value.max)
      if (maxInput !== undefined && (typeof maxInput !== 'number' || !Number.isInteger(maxInput) || maxInput < 1)) return failed(`max must be a whole number from 1 to ${MAX_LOG}.`)
      const max = Math.min(maxInput ?? DEFAULT_LOG, MAX_LOG)
      const run = await readGit(root.value, [
        'log', '--no-color', `--max-count=${max}`, '--date=short', '--format=%h %ad %an%d: %s', ...(path.value ? ['--', path.value] : [])
      ], ctx?.signal)
      const result = present(run, 'log', 'No commits.')
      return typeof maxInput === 'number' && maxInput > MAX_LOG && !result.isError
        ? succeeded(`${result.content as string}\n(max is capped at ${MAX_LOG} commits.)`) : result
    }
  }
}

function showTool(workspace: string): ExecutableTool {
  return {
    definition: {
      name: 'git_show',
      description:
        'Show one commit: its message and the changes it made (diffstat and unified diff). rev is a commit hash, branch, tag or expression such as HEAD~2. ' +
        'Pass path to limit the changes to one file or folder. To read a file\'s current content use read_file; rev:path is not supported. Output is capped near 60 KB.',
      inputSchema: {
        type: 'object',
        properties: {
          rev: { type: 'string', description: 'Commit-ish to show, for example HEAD, abc1234, main~3 or v1.2.0.' },
          path: { type: 'string', description: 'Workspace-relative file or folder to limit the changes to.' }
        },
        required: ['rev']
      }
    },
    defaultPermission: 'allow',
    async execute(input: JSONValue, ctx: ToolExecutionContext): Promise<ToolResult> {
      const fields = fieldsOf(input, 'git_show')
      if (!fields.ok) return failed(fields.error)
      const rev = validateRevision(fields.value.rev, 'rev')
      if (!rev.ok) return failed(rev.error)
      const root = gitWorkspace(workspace)
      if (!root.ok) return failed(root.error)
      const path = optionalPath(root.value, fields.value.path)
      if (!path.ok) return failed(path.error)
      const run = await readGit(root.value, [
        'show', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--no-color', '--stat', '--patch', rev.value,
        ...(path.value ? ['--', path.value] : [])
      ], ctx?.signal)
      return present(run, 'show', 'Nothing to show.')
    }
  }
}

function blameTool(workspace: string): ExecutableTool {
  return {
    definition: {
      name: 'git_blame',
      description:
        'Show, for each line of a tracked file, the commit and author that last changed it. startLine and endLine (1-based, inclusive) limit it to a range; ' +
        'give only startLine to read to the end of the file. Uncommitted edits appear as "Not Committed Yet". Output is capped near 60 KB.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path of a tracked file.' },
          startLine: { type: 'integer', description: 'First line to show (1-based).' },
          endLine: { type: 'integer', description: 'Last line to show (inclusive).' }
        },
        required: ['path']
      }
    },
    defaultPermission: 'allow',
    async execute(input: JSONValue, ctx: ToolExecutionContext): Promise<ToolResult> {
      const fields = fieldsOf(input, 'git_blame')
      if (!fields.ok) return failed(fields.error)
      const root = gitWorkspace(workspace)
      if (!root.ok) return failed(root.error)
      const path = resolveGitPath(root.value, fields.value.path, 'path')
      if (!path.ok) return failed(path.error)
      if (!path.value) return failed('git_blame needs the path of a file.')
      const start = optionalLine(fields.value.startLine, 'startLine')
      if (!start.ok) return failed(start.error)
      const end = optionalLine(fields.value.endLine, 'endLine')
      if (!end.ok) return failed(end.error)
      if (start.value !== undefined && end.value !== undefined && end.value < start.value) return failed('endLine must not be before startLine.')
      // Blame reads the working-tree file, and may be told to read an ignore-revs file too (see gitGuards).
      const refusal = worktreeRefusal(await inspectRepository(root.value, ctx?.signal), 'git_blame', { blame: true })
      if (refusal) return failed(refusal)
      const range = start.value === undefined && end.value === undefined ? [] : ['-L', `${start.value ?? 1},${end.value ?? ''}`]
      const run = await readGit(root.value, ['blame', '--no-textconv', '--date=short', ...range, '--', path.value], ctx?.signal)
      return present(run, 'blame', 'No lines.')
    }
  }
}

// --- git_commit --------------------------------------------------------------------------------------

const MAX_LISTED_FILES = 50

export interface GitToolsOptions {
  /** Time limit for git commit, which runs hooks. Defaults to two minutes. */
  commitTimeoutMs?: number
}

function formatCommit(outcome: Extract<CommitOutcome, { ok: true }>): string {
  const lines = [`Committed ${outcome.commit}${outcome.branch ? ` on ${outcome.branch}` : ''}: ${outcome.subject}`, ...outcome.summary.split('\n').slice(1)]
  for (const file of outcome.files.slice(0, MAX_LISTED_FILES)) {
    lines.push(`  ${file.path} ${file.added === null ? '(binary)' : `(+${file.added} -${file.removed ?? 0})`}`)
  }
  if (outcome.files.length > MAX_LISTED_FILES) lines.push(`  … and ${outcome.files.length - MAX_LISTED_FILES} more`)
  return lines.join('\n')
}

function commitTool(workspace: string, options: GitToolsOptions): ExecutableTool {
  return {
    definition: {
      name: 'git_commit',
      description:
        'Create a git commit. message is the commit message: an imperative first line of about 50 to 72 characters, then optionally a blank line and a body (1 to 2000 characters). ' +
        'paths lists the workspace-relative files to commit; exactly those are committed and anything else the user has staged is left alone. ' +
        'A new (untracked) file is committed only when it is listed in paths. When paths is omitted, every modified or deleted tracked file under the workspace is committed ' +
        '(like git commit -a) and untracked files never are; call git_status first so you know what that includes. ' +
        'Commit hooks run, and their output is returned if they reject the commit. This never pushes, amends or skips hooks: ask the user to do those. ' +
        'It asks the user for approval each time.',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', maxLength: MAX_COMMIT_MESSAGE, description: 'The commit message.' },
          paths: { type: 'array', items: { type: 'string' }, maxItems: MAX_COMMIT_PATHS, description: 'Workspace-relative files to commit. Omit to commit all tracked changes.' }
        },
        required: ['message']
      }
    },
    defaultPermission: 'ask',
    async execute(input: JSONValue, ctx: ToolExecutionContext): Promise<ToolResult> {
      const fields = fieldsOf(input, 'git_commit')
      if (!fields.ok) return failed(fields.error)
      const paths = given(fields.value.paths)
      const outcome = await commitChanges(workspace, { message: fields.value.message, ...(paths !== undefined ? { paths } : {}) }, {
        signal: ctx?.signal, ...(options.commitTimeoutMs ? { timeoutMs: options.commitTimeoutMs } : {})
      })
      return outcome.ok ? succeeded(formatCommit(outcome)) : failed(outcome.error)
    }
  }
}

// --- git_branch --------------------------------------------------------------------------------------

/** Starts with a letter or digit (never "-"), then the punctuation real branch names use. Git rules on the rest. */
const BRANCH_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._/+#=%,@-]*$/u

async function createBranch(root: string, name: string, from: string | undefined, checkout: boolean, signal: AbortSignal | undefined): Promise<ToolResult> {
  const git = (args: string[], extra: GitRunOptions = {}): Promise<GitRun> => runGit(root, [...READ_FLAGS, ...args], { signal, ...extra })
  const inside = await git(['rev-parse', '--is-inside-work-tree'], { readOnly: true })
  if (!inside.ok) return failed(inside.code === 128 ? 'This folder is not inside a git repository.' : describeGitFailure(inside, 'rev-parse'))
  // Git decides what a legal ref name is (no "..", no ".lock" ending, no "//").
  const legal = await git(['check-ref-format', '--branch', name], { readOnly: true })
  if (!legal.ok) return failed(legal.code === 1 || legal.code === 128 ? `"${name}" is not a legal branch name.` : describeGitFailure(legal, 'check-ref-format'))
  const existing = await git(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { readOnly: true })
  if (existing.ok) return failed(`Branch "${name}" already exists. Existing branches are never moved or replaced; choose another name.`)
  if (existing.code !== 1) return failed(describeGitFailure(existing, 'show-ref'))
  if (from) {
    const commit = await git(['rev-parse', '--verify', '--quiet', `${from}^{commit}`], { readOnly: true })
    if (!commit.ok) return failed(commit.code === 1 ? `"${from}" is not a commit in this repository.` : describeGitFailure(commit, 'rev-parse'))
  }
  // Never forced: a switch that would overwrite local changes is refused by git and creates nothing.
  const start = from ? [from] : []
  const created = await git(checkout ? ['switch', '--create', name, ...start] : ['branch', name, ...start], { timeoutMs: GIT_WRITE_TIMEOUT_MS })
  if (!created.ok) return failed(describeGitFailure(created, checkout ? 'switch' : 'branch'))
  const tip = await git(['rev-parse', '--short', `refs/heads/${name}`], { readOnly: true })
  const at = tip.ok && tip.stdout.trim() ? ` at ${tip.stdout.trim()}` : ''
  if (checkout) return succeeded(`Created branch "${name}"${at} and switched to it.`)
  const current = await git(['symbolic-ref', '--short', '-q', 'HEAD'], { readOnly: true })
  const still = current.ok && current.stdout.trim() ? `The working tree is still on "${current.stdout.trim()}".` : 'The working tree was not switched.'
  return succeeded(`Created branch "${name}"${at}. ${still}`)
}

function branchTool(workspace: string): ExecutableTool {
  return {
    definition: {
      name: 'git_branch',
      description:
        'Create a new branch, optionally starting from a revision (default HEAD), and optionally switch to it with checkout: true. ' +
        'It never moves, renames, deletes or overwrites an existing branch, and it never discards local changes: if switching would overwrite uncommitted work it stops and creates nothing. ' +
        'It asks the user for approval each time.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the new branch, for example feature/retry-backoff.' },
          from: { type: 'string', description: 'Revision to start the branch from: a branch, tag or commit. Default HEAD.' },
          checkout: { type: 'boolean', description: 'Switch the working tree to the new branch. Default false.' }
        },
        required: ['name']
      }
    },
    defaultPermission: 'ask',
    async execute(input: JSONValue, ctx: ToolExecutionContext): Promise<ToolResult> {
      const fields = fieldsOf(input, 'git_branch')
      if (!fields.ok) return failed(fields.error)
      const name = fields.value.name
      if (typeof name !== 'string' || !name) return failed('name must be the name of the new branch.')
      if (name.length > 200 || !BRANCH_NAME.test(name)) {
        return failed(`"${name.slice(0, 60).replace(/\s+/g, ' ')}" is not a usable branch name. Use letters, digits and . _ - / + # = % , @, starting with a letter or digit.`)
      }
      const fromInput = given(fields.value.from)
      const from = fromInput === undefined ? undefined : validateRevision(fromInput, 'from')
      if (from && !from.ok) return failed(from.error)
      const checkout = given(fields.value.checkout)
      if (checkout !== undefined && typeof checkout !== 'boolean') return failed('checkout must be true or false.')
      const root = gitWorkspace(workspace)
      if (!root.ok) return failed(root.error)
      return withRepoLock(root.value, () => createBranch(root.value, name, from?.value, checkout === true, ctx?.signal))
    }
  }
}

/** The model-facing git tools for one workspace. */
export function createGitTools(workspace: string, options: GitToolsOptions = {}): ExecutableTool[] {
  return [
    statusTool(workspace), diffTool(workspace), logTool(workspace), showTool(workspace), blameTool(workspace),
    commitTool(workspace, options), branchTool(workspace)
  ]
}
