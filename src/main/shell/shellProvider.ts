import { statSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import type { ShellId } from '@shared/ipc'

export type { ShellId } from '@shared/ipc'
export type ShellPreference = ShellId | 'auto'

/**
 * Which shell run_command uses, and exactly how a command line reaches it.
 *
 * Every shell is started with shell:false and the command travels as ONE argument
 * (or one PowerShell -EncodedCommand blob), so no second quoting layer can mangle
 * a path with spaces or a quote. That is the failure behind the Antigravity "rmdir /s /q d:\"
 * incident: `powershell -Command 'cmd /c "..."'` stripped nested quotes.
 */
export interface ShellSpec {
  id: ShellId
  /** Short name for the Settings picker. */
  label: string
  /** Executable to spawn with shell:false. */
  exe: string
  /** Arguments for spawn(exe, argv, { shell: false }). Throws ShellCommandTooLongError when the line cannot fit. */
  argv(command: string): string[]
  /** The exact script text the shell runs (PowerShell's -EncodedCommand hides it), for logs and tests. */
  script(command: string): string
  /** One or two sentences for the system prompt, so the model emits this shell's syntax. */
  syntaxNote: string
  /** Windows only: hand the arguments to CreateProcess untouched (cmd.exe parses its own line). */
  verbatimArguments?: boolean
  /** Set when the requested shell was not installed and another one was chosen. */
  fallbackFrom?: ShellId
}

/** What detection needs from the machine; tests inject a fake one. */
export interface ShellDeps {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** Every match for a program on PATH, in PATH order. */
  which(name: string): string[]
  exists(path: string): boolean
}

export interface ShellListing {
  id: ShellId
  label: string
  /** Absolute path of the executable; empty when the shell is not installed. */
  path: string
  available: boolean
}

export class ShellCommandTooLongError extends Error {
  constructor(shell: string, limit: number) {
    super(`This command is too long to pass to ${shell} on Windows (the limit is about ${limit} characters). ` +
      'Write it to a script file with write_file and run that file instead.')
    this.name = 'ShellCommandTooLongError'
  }
}

export const SHELL_IDS: readonly ShellId[] = ['git-bash', 'pwsh', 'powershell', 'cmd', 'posix']
const WINDOWS_AUTO_ORDER: readonly ShellId[] = ['git-bash', 'pwsh', 'powershell', 'cmd']

/** A stored or untrusted preference becomes a valid one; anything unknown means auto. */
export function normalizeShellPreference(value: unknown): ShellPreference {
  return typeof value === 'string' && (SHELL_IDS as readonly string[]).includes(value) ? value as ShellId : 'auto'
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile() } catch { return false }
}

function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[name]
  // Windows environment names are case-insensitive (Path versus PATH).
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : env[key]
}

/**
 * Every `<name>.exe` (or `<name>` off Windows) in the absolute PATH entries. Relative entries are
 * skipped: a workspace must never get to supply the shell that runs the model's commands.
 */
export function pathScan(name: string, deps: Pick<ShellDeps, 'platform' | 'env' | 'exists'>): string[] {
  const windows = deps.platform === 'win32'
  const path = windows ? win32 : posix
  const entries = (envValue(deps.env, 'PATH', deps.platform) ?? '').split(windows ? ';' : ':')
  const hits: string[] = []
  for (const entry of entries) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1')
    if (!dir || !path.isAbsolute(dir)) continue
    const candidate = path.join(dir, windows ? `${name}.exe` : name)
    if (deps.exists(candidate) && !hits.includes(candidate)) hits.push(candidate)
  }
  return hits
}

function realDeps(): ShellDeps {
  const base = { platform: process.platform, env: process.env, exists: isFile }
  return { ...base, which: (name) => pathScan(name, base) }
}

function findGitBash(deps: ShellDeps): string | undefined {
  const roots: string[] = []
  for (const git of deps.which('git')) {
    // <root>\cmd\git.exe, <root>\bin\git.exe, or <root>\mingw64\bin\git.exe.
    const dir = win32.dirname(git)
    roots.push(win32.dirname(dir), win32.dirname(win32.dirname(dir)))
  }
  const fromEnv = (name: string): string | undefined => envValue(deps.env, name, 'win32')
  const installRoot = fromEnv('GIT_INSTALL_ROOT')
  if (installRoot) roots.push(installRoot)
  for (const programs of [fromEnv('ProgramFiles'), fromEnv('ProgramW6432'), fromEnv('ProgramFiles(x86)')]) {
    if (programs) roots.push(win32.join(programs, 'Git'))
  }
  const local = fromEnv('LOCALAPPDATA')
  if (local) roots.push(win32.join(local, 'Programs', 'Git'))
  // Only <root>\bin\bash.exe is used. A bare `bash.exe` on PATH may be the WSL launcher in System32.
  for (const root of roots) {
    const bash = win32.join(root, 'bin', 'bash.exe')
    if (deps.exists(bash)) return bash
  }
  return undefined
}

function findPwsh(deps: ShellDeps): string | undefined {
  const onPath = deps.which('pwsh')[0]
  if (onPath) return onPath
  for (const name of ['ProgramFiles', 'ProgramW6432']) {
    const programs = envValue(deps.env, name, 'win32')
    const candidate = programs ? win32.join(programs, 'PowerShell', '7', 'pwsh.exe') : undefined
    if (candidate && deps.exists(candidate)) return candidate
  }
  return undefined
}

function systemDirectory(deps: ShellDeps): string {
  const root = envValue(deps.env, 'SystemRoot', 'win32') ?? envValue(deps.env, 'windir', 'win32') ?? 'C:\\Windows'
  return win32.join(root, 'System32')
}

function findWindowsPowerShell(deps: ShellDeps): string | undefined {
  const onPath = deps.which('powershell')[0]
  if (onPath) return onPath
  const bundled = win32.join(systemDirectory(deps), 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return deps.exists(bundled) ? bundled : undefined
}

/** cmd.exe always exists on Windows. ComSpec is trusted only when it really names a cmd.exe. */
function findCmd(deps: ShellDeps): string {
  const comSpec = envValue(deps.env, 'ComSpec', 'win32')
  if (comSpec && win32.isAbsolute(comSpec) && win32.basename(comSpec).toLowerCase() === 'cmd.exe' && deps.exists(comSpec)) return comSpec
  return win32.join(systemDirectory(deps), 'cmd.exe')
}

function detect(id: ShellId, deps: ShellDeps): string | undefined {
  if (deps.platform === 'win32') {
    switch (id) {
      case 'git-bash': return findGitBash(deps)
      case 'pwsh': return findPwsh(deps)
      case 'powershell': return findWindowsPowerShell(deps)
      case 'cmd': return findCmd(deps)
      default: return undefined
    }
  }
  return id === 'posix' ? (deps.exists('/bin/sh') ? '/bin/sh' : undefined) : undefined
}

// A Windows command line holds at most 32,767 characters; cmd.exe itself stops at 8,191.
const MAX_COMMAND_LINE = 32_000
const MAX_CMD_LINE = 8_000

function commandLineLength(exe: string, argv: string[]): number {
  return exe.length + 3 + argv.reduce((sum, arg) => sum + arg.length + 3 + (arg.match(/["\\]/g)?.length ?? 0), 0)
}

const POWERSHELL_PREAMBLE =
  "$ProgressPreference = 'SilentlyContinue'\n" +
  'try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }\n' +
  '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n'

/**
 * PowerShell exits 1 for any native failure when run with -Command or -EncodedCommand. Report the last
 * native command's own code instead; with no native command, a failed last statement is 1.
 * `$?` is captured first because evaluating any later expression resets it.
 */
const POWERSHELL_EPILOGUE =
  '\n$cubexOk = $?; $cubexCode = $LASTEXITCODE\n' +
  'if ($cubexCode) { exit $cubexCode } elseif ($null -eq $cubexCode -and -not $cubexOk) { exit 1 }\n'

export function buildPowerShellScript(command: string): string {
  // The command sits on its own lines so a trailing comment cannot swallow the epilogue.
  return `${POWERSHELL_PREAMBLE}${command}${POWERSHELL_EPILOGUE}`
}

function powerShell(id: 'pwsh' | 'powershell', exe: string): ShellSpec {
  const label = id === 'pwsh' ? 'PowerShell 7' : 'Windows PowerShell'
  return {
    id,
    label,
    exe,
    script: buildPowerShellScript,
    argv(command) {
      const encoded = Buffer.from(buildPowerShellScript(command), 'utf16le').toString('base64')
      // UTF-16 doubles the script and base64 adds a third again.
      if (commandLineLength(exe, [encoded]) > MAX_COMMAND_LINE) throw new ShellCommandTooLongError(label, 11_000)
      return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]
    },
    syntaxNote: id === 'pwsh'
      ? 'Commands run in PowerShell 7 (pwsh). Use PowerShell syntax: cmdlets such as Get-ChildItem, $env:NAME for environment variables, ; or && to chain, and quotes around paths with spaces. ' +
        'Bash and cmd.exe syntax (rm -rf, export, %VAR%) does not work.'
      : 'Commands run in Windows PowerShell 5.1. Use PowerShell syntax: cmdlets such as Get-ChildItem, $env:NAME for environment variables, and quotes around paths with spaces. ' +
        'In 5.1 && and || are not valid: chain with ; or use if ($?) { ... }. Bash and cmd.exe syntax (rm -rf, export, %VAR%) does not work.'
  }
}

function gitBash(exe: string): ShellSpec {
  return {
    id: 'git-bash',
    label: 'Git Bash',
    exe,
    script: (command) => command,
    argv(command) {
      const argv = ['-c', command]
      if (commandLineLength(exe, argv) > MAX_COMMAND_LINE) throw new ShellCommandTooLongError('Git Bash', 30_000)
      return argv
    },
    syntaxNote: 'Commands run in Git Bash (bash -c) on Windows. Use Bash syntax: forward slashes, quoted paths, && to chain, and $VAR for environment variables. ' +
      'Windows programs such as node, npm and git work; cmd.exe built-ins such as dir do not. ' +
      'A flag meant for a Windows tool, like /F, can be rewritten as a path: write it as //F or prefix the command with MSYS_NO_PATHCONV=1.'
  }
}

function commandPrompt(exe: string): ShellSpec {
  return {
    id: 'cmd',
    label: 'Command Prompt',
    exe,
    verbatimArguments: true,
    script: (command) => `chcp 65001>nul&${command}`,
    argv(command) {
      // /s keeps everything between the outer quotes verbatim, as Node's own shell:true does.
      const line = `"chcp 65001>nul&${command}"`
      if (line.length > MAX_CMD_LINE) throw new ShellCommandTooLongError('cmd.exe', MAX_CMD_LINE)
      return ['/d', '/s', '/c', line]
    },
    syntaxNote: 'Commands run through the Windows command shell (cmd.exe), not Bash or PowerShell. Use cmd syntax: && to chain, %VAR% for environment variables, dir and type. ' +
      'Invoke powershell explicitly when you need it, and quote paths containing spaces.'
  }
}

function posixShell(exe: string): ShellSpec {
  return {
    id: 'posix',
    label: 'sh',
    exe,
    script: (command) => command,
    argv: (command) => ['-c', command],
    syntaxNote: "Commands run through the platform shell (sh -c). Quote paths and arguments correctly, and use the repository's existing scripts."
  }
}

function build(id: ShellId, exe: string, fallbackFrom?: ShellId): ShellSpec {
  const spec = id === 'git-bash' ? gitBash(exe) : id === 'cmd' ? commandPrompt(exe)
    : id === 'posix' ? posixShell(exe) : powerShell(id, exe)
  return fallbackFrom ? { ...spec, fallbackFrom } : spec
}

/**
 * Pick the shell for a preference. Windows `auto` order: Git Bash, pwsh, Windows PowerShell, cmd.
 * A named shell that is not installed falls back through that same order, and the result carries
 * `fallbackFrom` so the caller can log it; the prompt always describes the shell actually used.
 */
export function resolveShell(preference: ShellPreference, deps: ShellDeps = realDeps()): ShellSpec {
  const wanted = normalizeShellPreference(preference)
  const order = deps.platform === 'win32' ? WINDOWS_AUTO_ORDER : (['posix'] as const)
  const candidates = wanted === 'auto' ? order : [wanted, ...order.filter((id) => id !== wanted)]
  for (const id of candidates) {
    const exe = detect(id, deps)
    if (exe) return build(id, exe, wanted !== 'auto' && id !== wanted ? wanted : undefined)
  }
  // Last resort: a bare name the OS will resolve.
  if (deps.platform === 'win32') return build('cmd', 'cmd.exe', wanted !== 'auto' && wanted !== 'cmd' ? wanted : undefined)
  return build('posix', 'sh', wanted !== 'auto' && wanted !== 'posix' ? wanted : undefined)
}

const LABELS: Record<ShellId, string> = {
  'git-bash': 'Git Bash', pwsh: 'PowerShell 7', powershell: 'Windows PowerShell', cmd: 'Command Prompt', posix: 'sh'
}

/** Every shell this platform can use, with where it was found, for the Settings picker. */
export function listShells(deps: ShellDeps = realDeps()): ShellListing[] {
  const ids = deps.platform === 'win32' ? WINDOWS_AUTO_ORDER : (['posix'] as const)
  return ids.map((id) => {
    const path = detect(id, deps) ?? ''
    return { id, label: LABELS[id], path, available: path !== '' }
  })
}
