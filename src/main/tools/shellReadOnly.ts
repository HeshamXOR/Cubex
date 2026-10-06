import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Conservative shell classification. Unrecognized syntax goes through permission review.
 *
 * `workspace` (when supplied) additionally confines every path-like argument to
 * the workspace: an auto-approved probe must never read `~/.ssh`, `C:\Users\…`
 * or `../../secrets`, because the result flows straight back into a model that
 * may be acting on injected instructions.
 */
export function isReadOnlyShellCommand(command: string, workspace?: string): boolean {
  const line = command.trim()
  if (!line || /[;&|><`$(){}\r\n%^!]/.test(line)) return false
  // Quotes are for literal paths only. Shell expansion/chaining was rejected above.
  const words = line.match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+/g)
  if (!words || words.join('').replace(/\s/g, '') !== line.replace(/\s/g, '')) return false
  const [head, ...args] = words.map((word) => word.replace(/^("|')([\s\S]*)\1$/, '$2'))
  const binary = head!.toLowerCase()
  if (workspace !== undefined && !argumentsStayInWorkspace(args, workspace)) return false
  if (workspace !== undefined && shadowedByWorkspace(binary, workspace)) return false
  const flagsOnly = (...allowed: string[]) => args.length > 0 && args.every((arg) => allowed.includes(arg))
  if (['node', 'npx', 'python', 'python3', 'bun'].includes(binary)) return flagsOnly('--version', '-V', '--help', '-h')
  if (['hostname', 'date', 'file', 'find'].includes(binary)) {
    // These have platform-specific write/execute flags. Keep only clear probes.
    if (binary === 'hostname') return args.length === 0
    return flagsOnly('--version', '--help')
  }
  if (binary === 'git') return readOnlyGit(args) && (workspace === undefined || repositoryConfigIsInert(workspace))
  if (['npm', 'pnpm', 'yarn'].includes(binary)) {
    return args.length > 0 && ['ls', 'list', 'outdated', 'view', '--version', '-v', '--help'].includes(args[0]!) &&
      !args.some((arg) => /^(?:--(?:prefix|cwd|userconfig|globalconfig|script-shell)|-C)(?:=|$)/.test(arg))
  }
  if (binary === 'rg') {
    return !args.some((arg) => /^(?:--pre|--hostname-bin)(?:=|$)/.test(arg))
  }
  return new Set(['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'grep', 'echo', 'whoami', 'stat', 'du', 'df', 'uname',
    'basename', 'dirname', 'realpath', 'which', 'where', 'type', 'dir', 'ver', 'tree']).has(binary)
}

const PATH_LIKE = /[\\/~]|^\.\.?$|^[A-Za-z]:/

/**
 * cmd.exe and CreateProcess look in the current directory before PATH (unless
 * NoDefaultCurrentDirectoryInExePath is set, which main does at startup). A
 * repository shipping `ls.bat` or `git.exe` must never turn an auto-approved
 * probe into its own program, so a same-named workspace file forces a prompt.
 */
export function shadowedByWorkspace(binary: string, workspace: string, platform = process.platform): boolean {
  if (platform !== 'win32') return false
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.PS1').split(';').filter(Boolean)
  return ['', ...extensions].some((extension) => existsSync(join(workspace, `${binary}${extension.toLowerCase()}`)))
}

/**
 * Every argument that could name a file must resolve inside the workspace, both
 * lexically and after following symlinks/junctions. Flags may not carry paths
 * (`-f/etc/passwd`, `--file=~/x`) because the attached value is not reliably
 * separable across tools; such commands fall back to an approval prompt.
 */
export function argumentsStayInWorkspace(args: string[], workspace: string): boolean {
  const root = canonical(resolve(workspace))
  for (const arg of args) {
    if (arg.startsWith('-')) {
      if (PATH_LIKE.test(arg.replace(/^-+/, '')) || arg.includes('=') && PATH_LIKE.test(arg.slice(arg.indexOf('=') + 1))) return false
      continue
    }
    if (arg.startsWith('~')) return false
    if (/^\\\\|^\/\//.test(arg)) return false // UNC / network paths
    // Globs are expanded by the shell; check the literal prefix the glob is anchored to.
    const literal = arg.split(/[*?[]/)[0] ?? ''
    const target = canonical(resolve(root, literal || '.'))
    const rel = relative(root, target)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false
  }
  return true
}

function canonical(path: string): string {
  let probe = path
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe)
  try { return resolve(realpathSync.native(probe), relative(probe, path)) } catch { return path }
}

/**
 * Repository-scoped git configuration can make "read-only" porcelain execute
 * programs: core.fsmonitor (git status), diff.external / textconv (git diff/log -p),
 * filter.*.clean (git status/diff), gpg.program with log.showSignature (git log)...
 * A workspace's .git/config is attacker-controllable (downloaded archives, agent
 * writes), so auto-approval requires that the local/worktree scopes carry none
 * of these keys. User-level (global/system) config is trusted.
 *
 * Two keys do not run programs but reach beyond the workspace: core.worktree makes
 * `git diff` / `git blame` print files from another folder, and blame.ignoreRevsFile
 * makes `git blame` read a file and repeat a line of it in its error. Subsection
 * names may contain dots (`filter.a.b.clean`), hence `.+` rather than `[^.]+`.
 */
const EXECUTABLE_GIT_KEY = /^(?:core\.(?:fsmonitor|hookspath|pager|editor|sshcommand|askpass|gitproxy|alternaterefscommand|worktree)|blame\.ignorerevsfile|diff\.external|diff\..+\.(?:textconv|command)|filter\..+\.(?:clean|smudge|process)|gpg(?:\..+)?\.program|log\.showsignature|credential\..*|merge\..+\.driver|sequence\.editor|interactive\.difffilter|uploadpack\..*|include\.path|includeif\..*)$/i

export function repositoryConfigIsInert(workspace: string): boolean {
  const scopes = ['--local', '--worktree']
  for (const scope of scopes) {
    const result = spawnSync('git', ['config', scope, '--list', '--name-only', '--includes'], {
      cwd: workspace, encoding: 'utf8', timeout: 3_000, windowsHide: true,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', NoDefaultCurrentDirectoryInExePath: '1' }
    })
    if (result.error) return false
    // Exit status 128 = not a repository / worktree config disabled: nothing repo-scoped to fear.
    if (result.status !== 0) continue
    if (result.stdout.split(/\r?\n/).some((key) => EXECUTABLE_GIT_KEY.test(key.trim()))) return false
  }
  // `git status` recurses into submodules, which read their own
  // .git/modules/<name>/config (filters, fsmonitor) that the scan above never
  // sees. Repositories with submodules are reviewed by a human instead.
  if (existsSync(join(workspace, '.gitmodules'))) return false
  const commonDir = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: workspace, encoding: 'utf8', timeout: 3_000, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', NoDefaultCurrentDirectoryInExePath: '1' }
  })
  if (commonDir.status === 0 && existsSync(join(resolve(workspace, commonDir.stdout.trim()), 'modules'))) return false
  return true
}

function readOnlyGit(args: string[]): boolean {
  const [sub, ...rest] = args
  if (!sub) return false
  // These flags can write files or invoke project-configured programs from an
  // otherwise read-only Git command. Unknown top-level Git flags aren't allowed.
  if (rest.some((arg) => /^(?:--(?:output|ext-diff|textconv|exec|config-env|show-signature|no-index)|-c)(?:=|$)/.test(arg))) return false
  if (['status', 'diff', 'log', 'show', 'ls-files', 'rev-parse', 'blame', 'describe'].includes(sub)) return true
  if (sub === 'branch' || sub === 'tag') {
    const displayFlags = ['--list', '--all', '-a', '--remotes', '-r', '--verbose', '-v', '-vv', '--no-color', '--color=never']
    if (rest.length === 0 || rest.every((arg) => displayFlags.includes(arg))) return true
    return rest.includes('--list') && rest.every((arg) => displayFlags.includes(arg) || !arg.startsWith('-'))
  }
  if (sub === 'remote') return rest.length === 0 || rest.every((arg) => ['-v', '--verbose'].includes(arg))
  if (sub === 'config') {
    const [operation, ...keys] = rest
    if (operation === '--list' || operation === '-l') return keys.length === 0
    if (operation === '--get' || operation === '--get-all') return keys.length === 1 && !keys[0]!.startsWith('-')
    if (operation === '--get-regexp') return keys.length >= 1 && keys.length <= 2 && keys.every((key) => !key.startsWith('-'))
  }
  return false
}

/**
 * Environment overrides applied to every auto-approved git probe as defence in
 * depth (GIT_CONFIG_PARAMETERS is equivalent to `git -c`). The config scan above
 * remains the primary gate because filters cannot be disabled generically.
 */
export const SAFE_GIT_ENV: Record<string, string> = {
  // Not diff.external='': git would try to spawn an empty command and every
  // `git diff` would fail. Repo-local diff.external is rejected by the scan.
  GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='false' 'core.pager'='cat' 'log.showSignature'='false'",
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat'
}
