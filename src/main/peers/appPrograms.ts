import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix as posixPath, win32 as winPath } from 'node:path'
import { LaunchError, locateCommand, type LaunchInput, type LaunchPlan } from '../mcp/resolveLaunch'

/**
 * Programs that a desktop app brings with it, and so are on the computer without being on its PATH. The Claude desktop app
 * keeps its own copy of Claude Code in its data folder, one folder per version; the Antigravity desktop app is installed
 * on its own and is a separate download from Google's command line. Cubex looks in the places those apps use, reads
 * nothing but folder and file names, and never opens a file the app keeps for itself, because that is where its login is.
 *
 * Nothing here is saved: the app updates itself and the folder of one version goes away with it, so each start asks again.
 */

export interface AppHost {
  platform: NodeJS.Platform
  home: string
  /** The names in a folder, or undefined when it is not a folder. */
  list(directory: string): string[] | undefined
  isFile(path: string): boolean
}

export const systemAppHost: AppHost = {
  platform: process.platform,
  home: homedir(),
  list(directory) {
    try { return readdirSync(directory) } catch { return undefined }
  },
  isFile(path) {
    try { return statSync(path).isFile() } catch { return false }
  }
}

export interface AppProgram {
  path: string
  /** The version the app keeps it under, when the folder says. */
  version?: string
  /** Where it was found, as the end of "Found in ...": "the Claude desktop app". */
  app: string
}

/** Where a program was found, as the end of the sentence "Found in ...". */
const CLAUDE_APP = 'the Claude desktop app'
export const ANTIGRAVITY_APP = 'the Antigravity desktop app'
const AGY_FOLDER = 'its usual install folder'

/** The three numbers of a version, or undefined when a name is not one: "2.1.181" is [2, 1, 181]. */
function versionParts(name: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(name)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

/** Negative when `a` is the older version. A name that is not a version is older than any that is. */
export function compareVersions(a: string, b: string): number {
  const left = versionParts(a)
  const right = versionParts(b)
  if (!left || !right) return left ? 1 : right ? -1 : 0
  for (let index = 0; index < 3; index++) {
    const difference = left[index]! - right[index]!
    if (difference !== 0) return difference
  }
  return 0
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(env)) if (key.toLowerCase() === wanted && value) return value
  return undefined
}

/** The folders of the Claude desktop app that hold a copy of Claude Code per version, standard app first and the "3p" build after it. */
export function claudeDesktopRoots(env: NodeJS.ProcessEnv, host: AppHost): string[] {
  if (host.platform === 'win32') {
    const appData = envValue(env, 'APPDATA') ?? winPath.join(host.home, 'AppData', 'Roaming')
    const localAppData = envValue(env, 'LOCALAPPDATA') ?? winPath.join(host.home, 'AppData', 'Local')
    return [
      winPath.join(appData, 'Claude', 'claude-code'),
      winPath.join(localAppData, 'Claude', 'claude-code'),
      winPath.join(appData, 'Claude-3p', 'claude-code'),
      winPath.join(localAppData, 'Claude-3p', 'claude-code')
    ]
  }
  if (host.platform === 'darwin') {
    const support = posixPath.join(host.home, 'Library', 'Application Support')
    return [posixPath.join(support, 'Claude', 'claude-code'), posixPath.join(support, 'Claude-3p', 'claude-code')]
  }
  const config = envValue(env, 'XDG_CONFIG_HOME') ?? posixPath.join(host.home, '.config')
  return [posixPath.join(config, 'Claude', 'claude-code'), posixPath.join(config, 'Claude-3p', 'claude-code')]
}

/** How many folders inside a version's folder are looked into: the 3p build keeps the program one level down, under a hash. */
const SUBFOLDERS_LOOKED_INTO = 8

/**
 * The newest copy of Claude Code that the Claude desktop app keeps. The standard app keeps `claude-code/<version>/claude.exe`
 * and the 3p build `claude-code/<version>/<hash>/claude.exe`. Between equal versions the standard app wins.
 */
export function claudeInDesktopApp(env: NodeJS.ProcessEnv = process.env, host: AppHost = systemAppHost): AppProgram | undefined {
  const join = host.platform === 'win32' ? winPath.join : posixPath.join
  const file = host.platform === 'win32' ? 'claude.exe' : 'claude'
  let best: { program: AppProgram; version: string } | undefined
  for (const root of claudeDesktopRoots(env, host)) {
    for (const name of host.list(root) ?? []) {
      const directory = join(root, name)
      const candidates = [join(directory, file)]
      for (const inner of (host.list(directory) ?? []).slice(0, SUBFOLDERS_LOOKED_INTO)) candidates.push(join(directory, inner, file))
      const path = candidates.find((candidate) => host.isFile(candidate))
      if (!path) continue
      if (!best || compareVersions(name, best.version) > 0) best = { version: name, program: { path, ...(versionParts(name) ? { version: name.replace(/^v/, '') } : {}), app: CLAUDE_APP } }
    }
  }
  return best?.program
}

/** Where Google's `agy` command line installs itself when nothing else was chosen, which is not a folder on PATH until its setup has run. */
export function agyDefaultPaths(env: NodeJS.ProcessEnv, host: AppHost): string[] {
  if (host.platform === 'win32') return [winPath.join(envValue(env, 'LOCALAPPDATA') ?? winPath.join(host.home, 'AppData', 'Local'), 'agy', 'bin', 'agy.exe')]
  return [posixPath.join(host.home, '.local', 'bin', 'agy')]
}

/** The Antigravity desktop app, when it is installed. It is an app to open, not a program to talk to: see `peers/antigravity`. */
export function antigravityDesktopApp(env: NodeJS.ProcessEnv = process.env, host: AppHost = systemAppHost): AppProgram | undefined {
  let candidates: string[]
  if (host.platform === 'win32') {
    const localAppData = envValue(env, 'LOCALAPPDATA') ?? winPath.join(host.home, 'AppData', 'Local')
    const programFiles = envValue(env, 'ProgramFiles') ?? 'C:\\Program Files'
    candidates = [winPath.join(localAppData, 'Programs', 'antigravity', 'Antigravity.exe'), winPath.join(programFiles, 'Antigravity', 'Antigravity.exe')]
  } else if (host.platform === 'darwin') {
    candidates = ['/Applications/Antigravity.app/Contents/MacOS/Electron', posixPath.join(host.home, 'Applications', 'Antigravity.app', 'Contents', 'MacOS', 'Electron')]
  } else {
    candidates = ['/opt/Antigravity/antigravity', '/usr/share/antigravity/antigravity']
  }
  const path = candidates.find((candidate) => host.isFile(candidate))
  return path ? { path, app: ANTIGRAVITY_APP } : undefined
}

/**
 * A program of a known name that a desktop app or its own installer put somewhere other than PATH: Claude Code in the Claude
 * desktop app, the `agy` command line in its default folder. Undefined for every other name.
 */
export function findAppProgram(command: string, env: NodeJS.ProcessEnv = process.env, host: AppHost = systemAppHost): AppProgram | undefined {
  const name = command.trim().toLowerCase().replace(/\.(exe|cmd|bat)$/, '')
  if (name === 'claude') return claudeInDesktopApp(env, host)
  if (name === 'agy') {
    const path = agyDefaultPaths(env, host).find((candidate) => host.isFile(candidate))
    return path ? { path, app: AGY_FOLDER } : undefined
  }
  return undefined
}

export interface LocatedProgram {
  path: string
  /** Where it was found, when that was not on PATH, as the end of "Found in ...". */
  app?: string
  /** The version the app keeps it under. */
  version?: string
}

/** Where a program is: on PATH and in the folders tools install to, and failing that where an app that brings it keeps it. */
export function locateProgram(command: string, env: NodeJS.ProcessEnv = process.env, host: AppHost = systemAppHost): LocatedProgram | undefined {
  const onPath = locateCommand({ command, env })
  if (onPath) return { path: onPath }
  const app = findAppProgram(command, env, host)
  return app ? { path: app.path, app: app.app, ...(app.version ? { version: app.version } : {}) } : undefined
}

/**
 * How to start a program: by the name it is given, and when that is not found, from where an app that brings it keeps it.
 * Any other failure, and a name no app brings, is the first failure.
 */
export function launchProgram(launch: (input: LaunchInput) => LaunchPlan, input: LaunchInput, host: AppHost = systemAppHost): LaunchPlan {
  try {
    return launch(input)
  } catch (error) {
    if (!(error instanceof LaunchError)) throw error
    const app = findAppProgram(input.command, input.env ?? process.env, host)
    if (app) {
      try { return launch({ ...input, command: app.path }) } catch { /* the first failure is the one that says what is missing */ }
    }
    throw error
  }
}
