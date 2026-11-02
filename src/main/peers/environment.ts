import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Where a program that is not on this process's PATH is looked for. A desktop app started from a menu inherits the
 * environment its parent had when the person logged in, so a tool installed since, or one whose installer only changed the
 * user's PATH in the registry, is on the PATH of every new terminal and not on this one. Two things close that gap: the
 * folders installers usually use, and (on Windows) the PATH the registry holds now.
 */

/** The folders command line tools usually land in, for the person's account. */
export function toolDirectories(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const home = homedir()
  if (platform === 'win32') {
    const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming')
    const localAppData = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    return [
      join(appData, 'npm'),
      join(home, '.local', 'bin'),
      join(home, '.claude', 'local'),
      join(home, '.npm-global', 'bin'),
      join(home, '.bun', 'bin'),
      join(home, 'scoop', 'shims'),
      join(localAppData, 'pnpm'),
      join(localAppData, 'Volta', 'bin')
    ]
  }
  return ['/usr/local/bin', '/opt/homebrew/bin', join(home, '.local', 'bin'), join(home, '.claude', 'local'), join(home, '.npm-global', 'bin'), join(home, '.bun', 'bin')]
}

const REGISTRY_KEYS = [
  'HKCU\\Environment',
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
] as const

/** What `reg query <key> /v Path` prints, reduced to the value, or undefined when there is none. */
export function parseRegistryPath(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s+Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i.exec(line)
    if (match) return match[1]!.trim()
  }
  return undefined
}

/** `%NAME%` replaced from the environment, case-insensitively. An entry that still has a variable in it afterwards is dropped. */
export function expandPathEntries(value: string, env: NodeJS.ProcessEnv): string[] {
  const lower = new Map<string, string>()
  for (const [key, entry] of Object.entries(env)) if (entry !== undefined) lower.set(key.toLowerCase(), entry)
  const out: string[] = []
  for (const raw of value.split(';')) {
    const entry = raw.trim().replace(/^"(.*)"$/, '$1').replace(/%([^%]+)%/g, (whole, name: string) => lower.get(name.toLowerCase()) ?? whole)
    if (entry && !entry.includes('%')) out.push(entry)
  }
  return out
}

export type RegistryReader = (key: string) => string | undefined

function readRegistry(key: string): string | undefined {
  try {
    const output = execFileSync('reg', ['query', key, '/v', 'Path'], { encoding: 'utf8', timeout: 3_000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    return parseRegistryPath(output)
  } catch {
    return undefined
  }
}

/** The PATH a new terminal would start with, from the registry: the user's entries, then the machine's. Never throws. */
export function registryPath(env: NodeJS.ProcessEnv = process.env, read: RegistryReader = readRegistry): string[] {
  const out: string[] = []
  for (const key of REGISTRY_KEYS) {
    const value = read(key)
    if (value) out.push(...expandPathEntries(value, env))
  }
  return out
}

const CACHE_MS = 30_000
let cached: { at: number; entries: string[] } | undefined

/** The registry PATH, read at most every half minute: starting `reg` is cheap, but a page of checks asks many times. Windows only. */
export function freshPathEntries(now: () => number = Date.now): string[] {
  if (process.platform !== 'win32') return []
  if (cached && now() - cached.at < CACHE_MS) return cached.entries
  cached = { at: now(), entries: registryPath() }
  return cached.entries
}

/** For tests: forget what was read. */
export function forgetFreshPath(): void {
  cached = undefined
}

const samePath = (a: string, b: string, platform: NodeJS.Platform): boolean => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

/** PATH with these entries added at the end, unless they are there already. The order the person's own PATH has is kept. */
export function withExtraPath(path: string, extra: readonly string[], platform: NodeJS.Platform = process.platform): string {
  const separator = platform === 'win32' ? ';' : ':'
  const entries = path.split(separator).filter(Boolean)
  for (const directory of extra) if (!entries.some((entry) => samePath(entry, directory, platform))) entries.push(directory)
  return entries.join(separator)
}
