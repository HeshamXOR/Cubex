import { closeSync, lstatSync, openSync, readSync, statSync } from 'node:fs'
import { posix as posixPath, win32 as winPath } from 'node:path'

/**
 * Decides how to start a child process for a command a user typed (an MCP server
 * entry, a hook, a language server). On Windows that is the hard part: Node cannot
 * start `npx` (ENOENT, the real file is npx.cmd) and refuses `.cmd` and `.bat`
 * files without a shell (EINVAL). So here:
 *   1. the command is looked up on PATH with PATHEXT, never in the working directory
 *      and never through a relative PATH entry (a planted binary in a workspace must not run);
 *   2. real executables are started directly;
 *   3. npm's own shims (npx, npm) and standard npm cmd-shims (pnpm, yarn, bunx and
 *      most globally installed tools) are read and their Node script is started
 *      directly, so no shell parses the arguments at all;
 *   4. any other batch file goes through `cmd.exe /d /v:off /s /c` with a command
 *      line quoted here, and arguments cmd.exe would reinterpret are refused.
 * Nothing is ever interpolated into a shell string without that quoting.
 */

export class LaunchError extends Error {}

export interface LaunchInput {
  command: string
  args?: readonly string[]
  /** Working directory the child will get; relative command paths resolve against it. */
  cwd?: string
  /** The child environment (PATH and PATHEXT are read from it). Defaults to process.env. */
  env?: Readonly<Record<string, string | undefined>>
}

export interface LaunchPlan {
  /** Pass to child_process.spawn as the file, with shell false. */
  file: string
  args: string[]
  /** Pass through to spawn: the cmd.exe route builds its own command line. */
  windowsVerbatimArguments: boolean
  mode: 'direct' | 'node-script' | 'cmd-shell'
}

export interface LaunchHost {
  platform: NodeJS.Platform
  isFile(path: string): boolean
  readText(path: string): string | undefined
}

const SHIM_READ_BYTES = 64 * 1024
const MAX_SHIM_LINE = 2000
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'
const NODE_PROGRAMS = new Set(['node', 'node.exe', '%dp0%\\node.exe', '%~dp0\\node.exe', '%dp0%node.exe', '%~dp0node.exe'])
/** The line of an npm cmd-shim that starts node: program, optional node flags, script under the shim's directory, %*. */
const SHIM_LINE = /(?:^|[\s&(@])"?(%_prog%|%~dp0\\?node\.exe|%dp0%\\?node\.exe|node(?:\.exe)?)"?((?:\s+--?[A-Za-z0-9][\w.=-]*)*)\s+"?(?:%~dp0|%dp0%)[\\/]?([^"%\r\n&|<>^]+?)"?\s+%\*\s*\)?\s*$/i

function readHead(path: string): string | undefined {
  try {
    const fd = openSync(path, 'r')
    try {
      const buffer = Buffer.alloc(SHIM_READ_BYTES)
      return buffer.subarray(0, readSync(fd, buffer, 0, SHIM_READ_BYTES, 0)).toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
}

export const systemHost: LaunchHost = {
  platform: process.platform,
  isFile(path) {
    try {
      return statSync(path).isFile()
    } catch {
      // App execution aliases (python.exe in WindowsApps) cannot be stat'ed through the reparse point.
      try { return lstatSync(path).isFile() } catch { return false }
    }
  },
  readText: readHead
}

/** Case-insensitive lookup; when a name appears twice the later key wins, like an object spread override. */
function envValue(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const wanted = name.toLowerCase()
  let found: string | undefined
  for (const [key, value] of Object.entries(env)) if (key.toLowerCase() === wanted && value !== undefined) found = value
  return found
}

function pathExtensions(env: Readonly<Record<string, string | undefined>>): string[] {
  const parsed = (envValue(env, 'PATHEXT') ?? DEFAULT_PATHEXT).split(';').map((e) => e.trim().toLowerCase()).filter((e) => e.startsWith('.'))
  return [...new Set(parsed.length > 0 ? parsed : DEFAULT_PATHEXT.toLowerCase().split(';'))]
}

/** The names Windows would try for `base`: as written when it already has a launchable extension, then with each PATHEXT entry. */
function nameCandidates(base: string, exts: readonly string[]): string[] {
  const own = exts.includes(winPath.extname(base).toLowerCase()) ? [base] : []
  return [...own, ...exts.map((ext) => base + ext)]
}

function isExplicitPath(command: string): boolean {
  return /[\\/]/.test(command) || /^[A-Za-z]:/.test(command)
}

function findOnWindows(command: string, input: LaunchInput, host: LaunchHost, exts: readonly string[], only?: readonly string[]): string | undefined {
  const allowed = (candidate: string): boolean => !only || only.includes(winPath.extname(candidate).toLowerCase())
  const env = input.env ?? process.env
  if (isExplicitPath(command)) {
    const base = winPath.isAbsolute(command) ? winPath.normalize(command) : winPath.resolve(input.cwd ?? process.cwd(), command)
    const found = nameCandidates(base, exts).find((candidate) => allowed(candidate) && host.isFile(candidate))
    if (found) return found
    if (!only && host.isFile(base)) {
      throw new LaunchError(`"${base}" is not a program Windows can start directly. Use an interpreter such as node or python as the command and pass the script as an argument.`)
    }
    return undefined
  }
  for (const raw of (envValue(env, 'PATH') ?? '').split(';')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1')
    // Relative entries would resolve inside the workspace: skip them (fail closed).
    if (!dir || !winPath.isAbsolute(dir)) continue
    const found = nameCandidates(winPath.join(dir, command), exts).find((candidate) => allowed(candidate) && host.isFile(candidate))
    if (found) return found
  }
  return undefined
}

function findNode(shimDirectory: string, input: LaunchInput, host: LaunchHost, exts: readonly string[]): string | undefined {
  const beside = winPath.join(shimDirectory, 'node.exe')
  if (host.isFile(beside)) return beside
  return findOnWindows('node', input, host, exts, ['.exe', '.com'])
}

function shimProgramIsNode(text: string): boolean {
  const assignments = [...text.matchAll(/set\s+"?_prog=([^"\r\n]*)"?/gi)].map((m) => m[1]!.trim().toLowerCase())
  return assignments.length > 0 && assignments.every((value) => NODE_PROGRAMS.has(value))
}

/** The node script (and node flags) an npm cmd-shim starts, or undefined when the file is not that shape. */
function readNpmShim(text: string): { flags: string[]; relative: string } | undefined {
  const lines = text.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (line.length > MAX_SHIM_LINE) continue
    const match = SHIM_LINE.exec(line)
    if (!match) continue
    if (match[1]!.toLowerCase() === '%_prog%' && !shimProgramIsNode(text)) return undefined
    return { flags: (match[2] ?? '').trim().split(/\s+/).filter(Boolean), relative: match[3]! }
  }
  return undefined
}

function quoteForCmd(value: string, position: string, always = false): string {
  // These cannot be neutralised reliably across cmd.exe's two parsing rounds, so refuse them.
  if (/[\u0000\r\n"%]/.test(value)) {
    throw new LaunchError(`The ${position} contains a quote, percent sign or line break, which cmd.exe would reinterpret. Start the server with node or an .exe instead of a .cmd file, or change that value.`)
  }
  if (value === '') return '""'
  // Inside quotes cmd.exe treats & | < > ^ ( ) literally; a trailing backslash must be doubled so it cannot escape the closing quote.
  if (always || /[\s&|<>^(),;=]/.test(value)) return `"${value.replace(/(\\+)$/, '$1$1')}"`
  return value
}

function cmdShellPlan(file: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>): LaunchPlan {
  const comspec = envValue(env, 'ComSpec') ?? winPath.join(envValue(env, 'SystemRoot') ?? envValue(env, 'windir') ?? 'C:\\Windows', 'System32', 'cmd.exe')
  const parts = [quoteForCmd(file, 'command path', true), ...args.map((arg, index) => quoteForCmd(arg, `argument ${index + 1}`))]
  // With /s, cmd.exe removes the outer pair of quotes and runs the rest as written.
  return { file: comspec, args: ['/d', '/v:off', '/s', '/c', `"${parts.join(' ')}"`], windowsVerbatimArguments: true, mode: 'cmd-shell' }
}

function resolveBatch(found: string, args: readonly string[], input: LaunchInput, host: LaunchHost, exts: readonly string[]): LaunchPlan {
  const env = input.env ?? process.env
  const directory = winPath.dirname(found)
  const name = winPath.basename(found, winPath.extname(found)).toLowerCase()

  // npm and npx as installed with Node: run the bundled CLI script with the node beside the shim.
  if (name === 'npm' || name === 'npx') {
    const script = winPath.join(directory, 'node_modules', 'npm', 'bin', `${name}-cli.js`)
    const node = host.isFile(script) ? findNode(directory, input, host, exts) : undefined
    if (node) return { file: node, args: [script, ...args], windowsVerbatimArguments: false, mode: 'node-script' }
  }

  const text = host.readText(found)
  const shim = text === undefined ? undefined : readNpmShim(text)
  if (shim) {
    const script = winPath.resolve(directory, shim.relative)
    const node = host.isFile(script) ? findNode(directory, input, host, exts) : undefined
    if (node) return { file: node, args: [...shim.flags, script, ...args], windowsVerbatimArguments: false, mode: 'node-script' }
  }
  return cmdShellPlan(found, args, env)
}

export function resolveLaunch(input: LaunchInput, host: LaunchHost = systemHost): LaunchPlan {
  const command = input.command.trim()
  const args = [...(input.args ?? [])]
  if (!command) throw new LaunchError('The command is empty.')
  if (/[\u0000\r\n]/.test(command)) throw new LaunchError('The command contains an invalid character.')
  if (host.platform !== 'win32') return { file: command, args, windowsVerbatimArguments: false, mode: 'direct' }

  const env = input.env ?? process.env
  const exts = pathExtensions(env)
  const found = findOnWindows(command, input, host, exts)
  if (!found) throw new LaunchError(`The command "${command}" was not found. Install it, add it to PATH, or give the full path to the program.`)

  const extension = winPath.extname(found).toLowerCase()
  if (extension === '.cmd' || extension === '.bat') return resolveBatch(found, args, input, host, exts)
  if (extension === '.exe' || extension === '.com') return { file: found, args, windowsVerbatimArguments: false, mode: 'direct' }
  throw new LaunchError(`"${found}" is not a program Windows can start directly. Use an interpreter such as node or python as the command and pass the script as an argument.`)
}

/**
 * The file a command would be started from, or undefined when there is none. On Windows this is the same lookup
 * resolveLaunch does (PATH and PATHEXT, never the working directory). Elsewhere the system searches PATH when a
 * process starts, so it is walked here. For showing where a program was found: never for running it.
 */
export function locateCommand(input: LaunchInput, host: LaunchHost = systemHost): string | undefined {
  const command = input.command.trim()
  if (!command || /[\u0000\r\n]/.test(command)) return undefined
  const env = input.env ?? process.env
  if (host.platform === 'win32') {
    try { return findOnWindows(command, input, host, pathExtensions(env)) } catch { return undefined }
  }
  if (/[\\/]/.test(command)) {
    const file = posixPath.resolve(input.cwd ?? process.cwd(), command)
    return host.isFile(file) ? file : undefined
  }
  for (const directory of (envValue(env, 'PATH') ?? '').split(':')) {
    // A relative entry would resolve inside the workspace: skip it, as the Windows lookup does.
    if (!directory || !posixPath.isAbsolute(directory)) continue
    const file = posixPath.join(directory, command)
    if (host.isFile(file)) return file
  }
  return undefined
}
