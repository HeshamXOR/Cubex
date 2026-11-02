// Helpers for the check.mjs of a task. A check is a plain node script: it is started as
//   node check.mjs <workspace> <answerFile>
// and passes by exiting 0. The environment carries CUBEX_EVAL_FIXTURE (the untouched fixture),
// CUBEX_EVAL_TASK_DIR (the task folder, where hidden tests live) and CUBEX_EVAL_ANSWER (the agent's last words).
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const workspace = process.argv[2] ?? process.env.CUBEX_EVAL_WORKSPACE ?? process.cwd()
export const fixture = process.env.CUBEX_EVAL_FIXTURE ?? ''
export const taskDir = process.env.CUBEX_EVAL_TASK_DIR ?? ''
export const answer = process.env.CUBEX_EVAL_ANSWER ?? ''

export function fail(message) {
  console.log(`FAIL: ${message}`)
  process.exit(1)
}

export function pass(message = 'ok') {
  console.log(`PASS: ${message}`)
  process.exit(0)
}

/** Fail with `message` unless `condition` holds. */
export function expect(condition, message) {
  if (!condition) fail(message)
}

export const path = (rel, root = workspace) => join(root, ...rel.split('/'))
export const exists = (rel, root = workspace) => existsSync(path(rel, root))
export const read = (rel, root = workspace) => readFileSync(path(rel, root), 'utf8')

const SKIP = new Set(['node_modules', '.git', '__pycache__', '.pytest_cache'])

/** Relative path of every file under a folder (default the workspace), forward slashes, sorted. */
export function files(root = workspace, dir = '') {
  const out = []
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const rel = dir ? `${dir}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...files(root, rel))
    else if (entry.isFile() && !entry.name.endsWith('.pyc')) out.push(rel)
  }
  return out.sort()
}

const sha = (file) => createHash('sha1').update(readFileSync(file)).digest('hex')

/** Files added (+), changed (~) or removed (-) in the workspace, compared with the fixture. */
export function changes() {
  const before = new Set(files(fixture))
  const after = new Set(files(workspace))
  const out = []
  for (const rel of after) {
    if (!before.has(rel)) out.push({ kind: '+', rel })
    else if (sha(path(rel, fixture)) !== sha(path(rel))) out.push({ kind: '~', rel })
  }
  for (const rel of before) if (!after.has(rel)) out.push({ kind: '-', rel })
  return out
}

/** Fail if any file other than the `allowed` ones (exact paths, or prefixes ending in /) was added, changed or removed. */
export function onlyTouched(allowed) {
  const ok = (rel) => allowed.some((item) => (item.endsWith('/') ? rel.startsWith(item) : rel === item))
  const stray = changes().filter((change) => !ok(change.rel))
  if (stray.length) fail(`files that should not have been touched were changed: ${stray.map((change) => `${change.kind} ${change.rel}`).join(', ')}`)
}

/** Fail unless a file is byte for byte what the fixture had. */
export function unchanged(rel) {
  expect(exists(rel), `${rel} was removed`)
  expect(sha(path(rel)) === sha(path(rel, fixture)), `${rel} was changed, and should not have been`)
}

/** Run a program; never throws. `python` is python3 where that exists. */
export function run(command, args = [], options = {}) {
  const program = command === 'python' ? pythonCommand() : command
  const result = spawnSync(program, args, { cwd: options.cwd ?? workspace, encoding: 'utf8', timeout: options.timeout ?? 60_000, input: options.input, env: { ...process.env, NO_COLOR: '1', ...(options.env ?? {}) } })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
    error: result.error
  }
}

let python
function pythonCommand() {
  if (python) return python
  python = ['python3', 'python'].find((name) => {
    const result = spawnSync(name, ['--version'], { stdio: 'ignore' })
    return !result.error && result.status === 0
  }) ?? 'python'
  return python
}

/** node --test on some files (default: the whole folder) in `cwd`. */
export function nodeTest(files = [], cwd = workspace) {
  return run(process.execPath, ['--test', ...files], { cwd })
}

/** Fail unless a command exits 0, and show its output when it does not. */
export function mustPass(label, result) {
  if (result.error) fail(`${label} could not run: ${result.error.message}`)
  if (result.status !== 0) fail(`${label} failed (exit ${result.status}):\n${result.output.slice(-2500)}`)
}

/** A throwaway copy of the workspace (or of `from`), removed when the check ends. */
export function scratchCopy(from = workspace) {
  const dir = mkdtempSync(join(tmpdir(), 'cubex-check-'))
  cpSync(from, dir, { recursive: true })
  process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* left to the system */ } })
  return dir
}

/** Copy files of the task's hidden/ folder into a folder: tests the agent never saw. */
export function addHidden(into, names = null) {
  const hidden = join(taskDir, 'hidden')
  for (const rel of names ?? files(hidden)) {
    const target = path(rel, into)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(path(rel, hidden), target)
  }
}

/** Write a file into a folder, making its folders. */
export function put(rel, text, root = workspace) {
  const target = path(rel, root)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text)
}
