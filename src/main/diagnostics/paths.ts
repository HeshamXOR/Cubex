import * as nodePath from 'node:path'

/**
 * Path helpers for the diagnostics engine. The `windows` parameter exists so the Windows rules (drive-letter
 * case, backslashes, UNC shares, case-insensitive names) are testable on any platform; callers omit it.
 */
const ON_WINDOWS = process.platform === 'win32'

function flavor(windows: boolean): nodePath.PlatformPath {
  return windows ? nodePath.win32 : nodePath.posix
}

/** Canonical comparison key: absolute, forward slashes, no trailing separator, lowercase on Windows. */
export function pathKey(p: string, windows = ON_WINDOWS): string {
  const resolved = flavor(windows).resolve(p)
  const slashed = windows ? resolved.replace(/\\/g, '/') : resolved
  const trimmed = slashed.length > 1 && slashed.endsWith('/') && !/^[A-Za-z]:\/$/.test(slashed) ? slashed.slice(0, -1) : slashed
  return windows ? trimmed.toLowerCase() : trimmed
}

/** True when `p` is `root` or lies below it. Lexical: callers that read files also check the real path. */
export function isWithinRoot(root: string, p: string, windows = ON_WINDOWS): boolean {
  const base = pathKey(root, windows)
  const key = pathKey(p, windows)
  return key === base || key.startsWith(base.endsWith('/') ? base : `${base}/`)
}

/** `p` relative to `root` with forward slashes and the file's own case; '' for the root, undefined when outside it. */
export function relativeToRoot(root: string, p: string, windows = ON_WINDOWS): string | undefined {
  const platform = flavor(windows)
  const relative = platform.relative(root, p)
  if (platform.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${platform.sep}`)) return undefined
  return windows ? relative.replace(/\\/g, '/') : relative
}

/** The spelling the TypeScript compiler API expects: absolute with forward slashes. */
export function tsPath(p: string, windows = ON_WINDOWS): string {
  const resolved = flavor(windows).resolve(p)
  return windows ? resolved.replace(/\\/g, '/') : resolved
}

/** node_modules of the folder and of each parent, nearest first: where Node and TypeScript look for packages. */
export function ancestorNodeModules(dir: string, windows = ON_WINDOWS): string[] {
  const platform = flavor(windows)
  const found: string[] = []
  let current = platform.resolve(dir)
  for (;;) {
    found.push(platform.join(current, 'node_modules'))
    const parent = platform.dirname(current)
    if (parent === current) return found
    current = parent
  }
}

/** The language family a file belongs to, by extension; undefined for anything the checker does not handle. */
export function sourceKind(file: string): 'ts' | 'js' | undefined {
  const lower = file.toLowerCase()
  if (/\.(?:[cm]?ts|tsx)$/.test(lower)) return 'ts'
  if (/\.(?:[cm]?js|jsx)$/.test(lower)) return 'js'
  return undefined
}
