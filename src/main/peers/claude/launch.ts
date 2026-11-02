import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModePurpose } from '../acp/modes'

/**
 * How Claude Code is started so that Cubex can hold it to the chat's permission mode. It is started in its stream-json mode
 * with `--permission-prompt-tool stdio`, which makes it ask the program on the other end before it uses a tool. What would
 * keep it from asking is switched off:
 *
 *  - `--tools` is the list of tools it has at all: a consultation gets the ones that read, a task gets the ones that change
 *    things too. Anything else, such as tools that start other agents, schedule work or change the folder, does not exist.
 *  - Its own settings can say "always allow" for a tool, or run hooks, or start in a mode that does not ask. The settings of the
 *    project are never loaded, because a project can carry hooks that run a command. The person's own settings are, for their
 *    sign-in and their model, and a settings file of Cubex's overrides them: every tool that reads, changes or reaches out is
 *    "ask", which beats "allow", hooks are off, and the mode that never asks cannot be entered.
 *  - Commits and pull requests get no "co-authored by Claude" line: whether they carry one is the person's call, made in their
 *    own Git, not by a program that Cubex started.
 *
 * Both rules were tried against the real program, with a stand-in for the model, in the versions 2.1.181 and 2.1.293.
 */

const READING_TOOLS = ['Read', 'Grep', 'Glob'] as const
const CHANGING_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch'] as const

/**
 * The tools Claude Code is started with. A name the version does not have is ignored (Bash is not there when it runs
 * PowerShell instead), so the lists name both and older tools too.
 */
export function claudeTools(purpose: ModePurpose): string[] {
  const reading = [...READING_TOOLS, 'LS']
  return purpose === 'work' ? [...reading, ...CHANGING_TOOLS, 'MultiEdit', 'TodoWrite'] : reading
}

/** Every tool that touches the folder or the network. Claude Code is told to ask about each, whatever its settings allow. */
export const ASKED_TOOLS: readonly string[] = [...READING_TOOLS, ...CHANGING_TOOLS]

/** The settings Cubex gives Claude Code on top of the person's own, which they win over. */
export function policySettings(): Record<string, unknown> {
  return {
    permissions: { ask: [...ASKED_TOOLS], defaultMode: 'default', disableBypassPermissionsMode: 'disable' },
    disableAllHooks: true,
    attribution: { commit: '', pr: '' },
    includeCoAuthoredBy: false
  }
}

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,79}$/

/** The model the person chose, from `--model name` among the agent's arguments. Nothing else in them is passed on. */
export function modelFrom(args: readonly string[] | undefined): string | undefined {
  if (!args) return undefined
  for (let index = 0; index < args.length; index++) {
    const entry = args[index]!
    const value = entry === '--model' || entry === '-m' ? args[index + 1] : entry.startsWith('--model=') ? entry.slice('--model='.length) : undefined
    if (value !== undefined && MODEL.test(value)) return value
  }
  return undefined
}

export interface ClaudeArgumentsInput {
  purpose: ModePurpose
  /** The file `policySettings()` was written to. */
  settingsFile: string
  model?: string | undefined
}

export function claudeArguments(input: ClaudeArgumentsInput): string[] {
  return [
    '--output-format', 'stream-json',
    '--verbose',
    '--input-format', 'stream-json',
    '--permission-prompt-tool', 'stdio',
    '--permission-mode', 'default',
    '--setting-sources', 'user',
    '--settings', input.settingsFile,
    '--strict-mcp-config',
    '--no-session-persistence',
    '--tools', claudeTools(input.purpose).join(','),
    ...(input.model ? ['--model', input.model] : [])
  ]
}

/** Variables that tell Claude Code it is inside another Claude Code, or where the host's own session is. */
const HOST_VARIABLES = /^(?:CLAUDECODE|CLAUDE_CODE_SSE_PORT|CLAUDE_CODE_SESSION_ID|CLAUDE_CODE_PARENT_SESSION_ID)$/i

/** The environment Claude Code gets: the one an agent gets, without a host's session markers, with no self-update, and named for what started it. */
export function claudeEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) if (!HOST_VARIABLES.test(key)) env[key] = value
  // The program may be the one a desktop app keeps up to date, and a self-update could replace it while it runs.
  env.DISABLE_AUTOUPDATER = '1'
  env.CLAUDE_CODE_ENTRYPOINT = 'cubex'
  return env
}

// --- The settings file ---------------------------------------------------------------

const SETTINGS_MAX_AGE_MS = 24 * 3_600_000
let swept = false

function settingsRoot(): string {
  return join(tmpdir(), 'cubex-claude')
}

/** Folders a crash left behind are removed once a day's age is passed. */
function sweep(root: string): void {
  if (swept) return
  swept = true
  try {
    for (const name of readdirSync(root)) {
      const path = join(root, name)
      try { if (Date.now() - statSync(path).mtimeMs > SETTINGS_MAX_AGE_MS) rmSync(path, { recursive: true, force: true }) } catch { /* in use: next time */ }
    }
  } catch { /* nothing to sweep */ }
}

export interface SettingsFile {
  file: string
  remove(): void
}

/** The settings of `policySettings()` in a folder of their own, for `--settings`. A file, because quoting JSON for a command line is how it goes wrong. */
export function writeSettingsFile(): SettingsFile {
  const root = settingsRoot()
  mkdirSync(root, { recursive: true })
  sweep(root)
  const directory = mkdtempSync(join(root, 's-'))
  const file = join(directory, 'settings.json')
  try {
    writeFileSync(file, `${JSON.stringify(policySettings(), null, 2)}\n`, { mode: 0o600 })
  } catch (error) {
    try { rmSync(directory, { recursive: true, force: true }) } catch { /* swept later */ }
    throw error
  }
  return {
    file,
    remove: () => {
      try { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* swept later */ }
    }
  }
}
