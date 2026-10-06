import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { shadowedByWorkspace } from './shellReadOnly'

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string }

const ok = <T>(value: T): Checked<T> => ({ ok: true, value })
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

/** Inside `root` (or equal to it), by relative path so Windows case, drive roots and UNC paths all work. */
function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

/** Resolve the nearest existing ancestor through links, then re-append the part that does not exist yet. */
function canonical(path: string): string {
  let probe = path
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe)
  try { return resolve(realpathSync.native(probe), relative(probe, path)) } catch { return path }
}

/**
 * The canonical workspace folder, or why git must not run there. A git.exe or
 * git.bat planted in the workspace would run in place of the real program
 * (Windows searches the current directory first), so its presence refuses.
 */
export function gitWorkspace(workspace: string | undefined): Checked<string> {
  if (!workspace) return fail('No workspace folder is selected for this task.')
  let root: string
  try {
    root = realpathSync.native(resolve(workspace))
    if (!lstatSync(root).isDirectory()) return fail('The workspace must be a folder.')
  } catch { return fail('The workspace folder could not be opened.') }
  if (shadowedByWorkspace('git', root)) {
    return fail('The workspace folder contains a file named "git" that Windows could run in place of Git, so Cubex will not run git here. Rename or remove that file.')
  }
  return ok(root)
}

const shown = (value: string): string => (value.length > 80 ? `${value.slice(0, 80)}…` : value)

/** Git treats `.git` (and its NTFS short name) as repository internals, never as content. */
const isGitInternal = (segment: string): boolean => {
  const name = segment.replace(/[. ]+$/, '').toLowerCase()
  return name === '.git' || name === 'git~1'
}

/**
 * A workspace-relative POSIX path that is safe to hand to git after `--`. Accepts
 * relative paths and absolute paths inside the workspace; `''` means the
 * workspace folder itself. Rejected: anything outside the workspace, lexically or
 * through a symlink/junction, network paths, `:` (git pathspec magic such as
 * `:(top)` and NTFS streams), control characters and `.git` internals. The path
 * may name something that no longer exists (a deleted file). `root` must come
 * from gitWorkspace().
 */
export function resolveGitPath(root: string, input: unknown, label = 'path'): Checked<string> {
  if (typeof input !== 'string') return fail(`${label} must be a string.`)
  if (input.length > 4096) return fail(`${label} is too long.`)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(input)) return fail(`${label} may not contain control characters.`)
  if (/^[\\/]{2}/.test(input)) return fail(`Network paths are not allowed (${label} "${shown(input)}").`)
  if ((/^[A-Za-z]:[\\/]/.test(input) ? input.slice(2) : input).includes(':')) {
    return fail(`${label} "${shown(input)}" may not contain ":" (git pathspec magic is not accepted).`)
  }
  const target = resolve(root, input)
  const outside = `${label} "${shown(input)}" is outside the workspace.`
  // Where the entry really is: its folder resolved through links (and 8.3 short names or case on
  // Windows), plus its own name. The name itself is not followed, so a tracked symlink stays a symlink.
  const physical = join(canonical(dirname(target)), basename(target))
  if (!inside(root, physical)) return fail(inside(root, target) ? `${outside.slice(0, -1)} (it passes through a link).` : outside)
  const rel = relative(root, physical)
  if (rel === '') return ok('')
  // The final component may be a link too, but only to somewhere inside the workspace.
  try {
    lstatSync(target)
    if (!inside(root, realpathSync.native(target))) return fail(`${outside.slice(0, -1)} (it is a link).`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return fail(`${label} "${shown(input)}" could not be read.`)
  }
  if (rel.split(sep).some(isGitInternal)) return fail(`${label} "${shown(input)}" is inside the .git folder, which is not available.`)
  return ok(rel.split(sep).join('/'))
}

/** Many paths at once; `''` (the workspace itself) is not accepted in a list. */
export function resolveGitPaths(root: string, inputs: unknown, label = 'paths'): Checked<string[]> {
  if (!Array.isArray(inputs)) return fail(`${label} must be a list of workspace-relative file paths.`)
  const paths: string[] = []
  for (const input of inputs) {
    const checked = resolveGitPath(root, input, 'path')
    if (!checked.ok) return checked
    if (!checked.value) return fail('Name specific files or folders; the whole workspace folder is not accepted here.')
    if (!paths.includes(checked.value)) paths.push(checked.value)
  }
  return ok(paths)
}

/** Letters, digits and the punctuation that real branch, tag and `HEAD~2@{1}` style names use. */
const REVISION = /^[\p{L}\p{N}_@{}^~./+#=%,-]+$/u

/**
 * A single revision argument. It may not start with `-` (option injection, since
 * a revision cannot be separated from options with `--`), and it may not contain
 * `:` because `rev:path` reads a file and `:/text` searches messages; file reads
 * belong to the file tools, and one file's history uses the path argument.
 */
export function validateRevision(value: unknown, label = 'rev'): Checked<string> {
  if (typeof value !== 'string') return fail(`${label} must be a string.`)
  if (!value || value.length > 200) return fail(`${label} must be 1 to 200 characters.`)
  if (value.startsWith('-')) return fail(`${label} may not start with "-".`)
  if (value.includes(':')) return fail(`${label} may not contain ":". Use the path argument to look at one file.`)
  if (!REVISION.test(value)) return fail(`${label} "${shown(value.replace(/\s+/g, ' '))}" contains characters that are not valid in a revision.`)
  return ok(value)
}
