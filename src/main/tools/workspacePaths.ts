import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Workspace path guard shared by every path-taking file tool.
 *
 * A path is rejected unless it stays inside the workspace after lexical
 * normalization AND after every symlink, junction and alias on it is resolved.
 * On Windows it must also be spelled the way the file system will read it: names
 * Win32 reinterprets (devices, alternate streams, trailing dots and spaces, 8.3
 * aliases, case-folding look-alikes) are refused, so a path the chat loop's
 * protected-folder rule judges by its spelling cannot reach a protected folder
 * under another spelling.
 */

/** Folders whose contents change how git, Cubex or other tools execute. Matches the chat loop's protected-path rule. */
const PROTECTED = /(?:^|[\\/])(?:\.git|\.cubex|\.claude|\.agents|\.codex|\.vscode|\.husky)(?:[\\/]|$)/i

export function isProtectedPath(path: string): boolean {
  return PROTECTED.test(path)
}

/** Canonicalize a path, falling back to a lexical resolve if it doesn't exist. */
export function realpathSafe(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return resolve(p)
  }
}

function isWithin(base: string, candidate: string): boolean {
  const path = relative(base, candidate)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

// Superscript digits 1-3 are reserved too (COM1, LPT2 ...) on current Windows.
const SUPERSCRIPT_DIGITS = String.fromCharCode(0xb9, 0xb2, 0xb3)
const RESERVED_DEVICE = new RegExp(`^(?:con|prn|aux|nul|conin\\$|conout\\$|(?:com|lpt)[1-9${SUPERSCRIPT_DIGITS}])$`, 'i')

/**
 * Why a single path component is unusable on Windows, or undefined when it is fine.
 * Pure string logic: callers decide whether the platform makes it apply.
 */
export function windowsNameProblem(name: string): string | undefined {
  const shown = JSON.stringify(name)
  if (/[<>"|?*\x00-\x1f]/.test(name)) return `Characters < > " | ? * and control characters are not allowed in a Windows path: ${shown}.`
  // The device name is whatever precedes the first dot, ignoring spaces before that dot: "NUL .txt" is NUL.
  const stem = name.split('.')[0]!.replace(/ +$/, '')
  if (RESERVED_DEVICE.test(stem)) return `Reserved Windows device name "${stem}" is not allowed in a path: ${shown}.`
  if (name.includes(':')) return `Alternate data streams (a ":" in a name) are not allowed in a path: ${shown}.`
  // Win32 silently drops these, so "config." opens "config" and ".git./x" opens ".git/x".
  if (/[. ]$/.test(name)) return `A name that ends in a dot or space is not allowed on Windows, because it names a different file than it spells: ${shown}.`
  return undefined
}

/** The nearest path that exists, counting a link whose target is missing as existing. */
function existingAncestor(path: string): string {
  let probe = path
  for (;;) {
    try {
      lstatSync(probe)
      return probe
    } catch { /* absent, or reached through a link whose target is missing */ }
    const parent = dirname(probe)
    if (parent === probe) return probe
    probe = parent
  }
}

function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink() } catch { return false }
}

/**
 * Each existing component must be exactly the on-disk name, apart from letter case.
 * That refuses 8.3 short names ("GIT~1") and any other spelling the volume maps to a
 * real entry (case-folding look-alikes), none of which a spelling-based rule can see.
 */
function assertRealSpelling(realRoot: string, names: readonly string[]): void {
  let current = realRoot
  for (const name of names) {
    const candidate = join(current, name)
    let real: string
    try { real = realpathSync.native(candidate) } catch { return }
    // A link legitimately has a different name from its target; only plain entries must match their on-disk name.
    if (!isLink(candidate)) {
      const actual = basename(real)
      if (actual.toLowerCase() !== name.toLowerCase()) {
        throw new Error(`"${name}" is a Windows short (8.3) alias or look-alike spelling of "${actual}". Use the real name "${actual}".`)
      }
    }
    current = real
  }
}

export interface ResolveOptions {
  /** The path is about to be changed: also refuse any spelling that reaches a protected folder through a link or alias. */
  mutating?: boolean
  /** The path was produced by listing a directory, so its names are already the on-disk spellings. */
  listed?: boolean
}

export function safeResolve(root: string, rel: string, options: ResolveOptions = {}): string {
  const abs = resolve(root, rel ?? '.')
  // Lexical containment comes first, before any filesystem access: a UNC or device
  // path must be rejected without ever being opened (opening one can leak credentials).
  if (!isWithin(root, abs)) throw new Error(`Path escapes the workspace: ${rel}`)
  const names = relative(root, abs).split(sep).filter(Boolean)
  if (process.platform === 'win32') {
    for (const name of names) {
      const problem = windowsNameProblem(name)
      if (problem) throw new Error(problem)
    }
  }
  // Lexical containment is not enough: a symlink inside the workspace could
  // point outside it. Canonicalize the deepest existing ancestor (a write
  // target may not exist yet) and re-check containment against the real root.
  const realRoot = realpathSafe(root)
  const probe = existingAncestor(abs)
  let real: string
  try {
    real = realpathSync.native(probe)
  } catch {
    // An entry that exists but cannot be resolved is a link whose target is gone;
    // writing "through" it would create the target wherever it points.
    if (isLink(probe)) throw new Error(`The path goes through a symbolic link whose target does not exist: ${rel}`)
    real = resolve(probe)
  }
  if (!isWithin(realRoot, real)) throw new Error(`Path escapes the workspace: ${rel}`)
  if (process.platform === 'win32' && !options.listed) assertRealSpelling(realRoot, names)
  if (options.mutating) {
    // The chat loop judges protected folders by the spelling it was given. A link or
    // alias must not carry a change into one under an innocent-looking name.
    const target = relative(realRoot, resolve(real, relative(probe, abs)))
    if (isProtectedPath(target) && !isProtectedPath(relative(root, abs))) {
      throw new Error(`Refusing to change ${rel}: it reaches a protected folder (${target.split(sep).join('/')}) through a link or alias. Use the real path.`)
    }
  }
  return abs
}
