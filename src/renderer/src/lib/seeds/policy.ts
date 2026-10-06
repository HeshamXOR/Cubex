import type { PermissionRule } from '../../../../shared/ipc'
import { mcpSecretRef, type HookTestResult, type McpServerStatus, type McpTestResult, type McpToolSummary } from '../../../../shared/policy'
import { DEFAULT_SETTINGS, type AppSettings, type HookConfig, type McpServerConfig } from '../../../../shared/settings'
import type { PreviewSeed } from './index'

/**
 * Sample data for the permissions, MCP servers and hooks groups. `?seed=1&policy=1` fills them;
 * `policy=env` is the same with the sentry server's saved token gone, `policy=empty` shows the empty states,
 * `policy=loading` never answers, `policy=error` fails the reads.
 * Commands with `missing`, `exit`, `block`, `fail`, `timeout` or `busy` in them give the failing test results.
 * Typing `nosave` as a secret value makes the credential store refuse it.
 */

const WORKSPACE = 'C:\\Users\\dev\\code\\lumen-web'
const MIN = 60_000
const DAY = 24 * 60 * MIN
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const rule = (id: string, workspace: string, tool: string, pattern: string, label: string, ageMs: number): PermissionRule =>
  ({ id, workspace, tool, pattern, label, createdAt: Date.now() - ageMs })

const rules = (): PermissionRule[] => [
  rule('r1', WORKSPACE, 'run_command', 'npm test', 'npm test', 3 * DAY),
  rule('r2', WORKSPACE, 'run_command', 'npm run build', 'npm run build', 2 * DAY),
  rule('r3', WORKSPACE, 'edit_file', '*', 'Edits in lumen-web', 5 * DAY),
  rule('r4', WORKSPACE, 'write_file', '*', 'Edits in lumen-web', 5 * DAY - MIN),
  rule('r5', WORKSPACE, 'web_fetch', 'docs.stripe.com', 'docs.stripe.com', DAY),
  rule('r6', WORKSPACE, 'mcp__filesystem__read_multiple_files', '*', 'read_multiple_files from filesystem', 4 * 60 * MIN),
  rule('r7', WORKSPACE, 'git_commit', '*', 'Commits', 6 * DAY),
  rule('r8', 'C:\\Users\\dev\\code\\aurora-site', 'run_command', 'pnpm lint', 'pnpm lint', 9 * DAY),
  rule('r9', 'C:\\Users\\dev\\code\\aurora-site', 'web_fetch', 'developer.mozilla.org', 'developer.mozilla.org', 12 * DAY),
  rule('r10', 'C:\\Users\\dev\\code\\aurora-site', 'delegate_to_subagent', '*', 'Subagents', 20 * DAY),
  rule('r11', 'D:\\work\\research\\ml-pipeline-with-a-very-long-folder-name\\experiments\\2026-q3-ablations', 'run_command', 'python -m pytest', 'python -m pytest', 30 * DAY)
]

const tools = (names: Array<[string, string?]>): McpToolSummary[] => names.map(([name, description]) => ({ name, ...(description ? { description } : {}) }))

const FILESYSTEM_TOOLS = tools([
  ['read_text_file', 'Read the complete contents of a file from the file system as text. Handles various text encodings and provides detailed error messages if the file cannot be read.'],
  ['read_multiple_files', 'Read the contents of multiple files simultaneously. Each file content is returned with its path as a reference. Failed reads for individual files will not stop the entire operation.'],
  ['write_file', 'Create a new file or completely overwrite an existing file with new content.'],
  ['edit_file', 'Make line-based edits to a text file. Each edit replaces exact line sequences with new content. Returns a git-style diff showing the changes made.'],
  ['create_directory', 'Create a new directory or ensure a directory exists.'],
  ['list_directory', 'Get a detailed listing of all files and directories in a specified path.'],
  ['list_directory_with_sizes', 'Get a detailed listing of all files and directories in a specified path, including sizes.'],
  ['directory_tree', 'Get a recursive tree view of files and directories as a JSON structure.'],
  ['move_file', 'Move or rename files and directories.'],
  ['search_files', 'Recursively search for files and directories matching a pattern.'],
  ['get_file_info', 'Retrieve detailed metadata about a file or directory.'],
  ['list_allowed_directories', 'Returns the list of directories that this server is allowed to access.'],
  ['read_media_file', 'Read an image or audio file and return it as base64 data with its MIME type.'],
  ['search_in_files']
])

const servers = (tokenGone: boolean): McpServerConfig[] => [
  { id: 'srv-files', name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', WORKSPACE], enabled: true },
  {
    id: 'srv-github',
    name: 'github',
    command: 'uvx',
    args: ['mcp-server-github'],
    env: { GITHUB_API_URL: 'https://api.github.com' },
    secretEnv: { GITHUB_TOKEN: mcpSecretRef('srv-github', 'GITHUB_TOKEN') },
    enabled: true
  },
  {
    id: 'srv-sentry',
    name: 'sentry',
    command: 'npx',
    args: ['-y', '@sentry/mcp-server'],
    ...(tokenGone ? { env: { SENTRY_ORG: 'lumen' }, secretEnv: { SENTRY_ACCESS_TOKEN: mcpSecretRef('srv-sentry', 'SENTRY_ACCESS_TOKEN') } } : {}),
    enabled: true
  },
  {
    id: 'srv-docs',
    name: 'team-docs',
    command: 'node',
    args: ['C:\\Users\\dev\\AppData\\Local\\Programs\\team-docs-mcp\\dist\\server.js', '--index', 'C:\\Users\\dev\\Documents\\Team Wiki\\exports\\2026', '--max-results', '20', '--verbose'],
    env: { TEAM_DOCS_INDEX: 'C:\\Users\\dev\\Documents\\Team Wiki\\exports\\2026', LOG_LEVEL: 'info' },
    enabled: true
  },
  {
    id: 'srv-postgres',
    name: 'postgres',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/lumen'],
    secretEnv: { PGPASSWORD: mcpSecretRef('srv-postgres', 'PGPASSWORD') },
    enabled: false
  }
]

const hooks = (): HookConfig[] => [
  { id: 'hook-guard', event: 'PreToolUse', matcher: 'write_file|edit_file', command: 'node scripts/guard-env.mjs', enabled: true },
  { id: 'hook-format', event: 'PostToolUse', matcher: 'write_file', command: 'npx prettier --write', enabled: true },
  { id: 'hook-log', event: 'Stop', command: 'powershell -NoProfile -Command "Add-Content -Path .\\logs\\turns.txt -Value (Get-Date -Format o); Get-ChildItem .\\logs | Measure-Object | Select-Object -ExpandProperty Count"', enabled: false }
]

/** What the real diagnosis says for a secret whose saved value is gone. */
const missingSentence = (names: readonly string[]): string => (names.length === 1
  ? `The saved value of \`${names[0]}\` is no longer available. Enter it again in Settings.`
  : `The saved values of ${names.map((name) => `\`${name}\``).join(' and ')} are no longer available. Enter them again in Settings.`)
const MISSING_HINT = 'Open Environment variables on this server and enter the value again.'

const SENTRY_OUTPUT = 'Sentry MCP server 0.9.1\nError: SENTRY_ACCESS_TOKEN is required. Create a token at sentry.io/settings/account/api/auth-tokens/ and set it in the environment.\n    at loadConfig (file:///C:/Users/dev/AppData/Local/npm-cache/_npx/4f1e/node_modules/@sentry/mcp-server/dist/config.js:41:11)'
const SENTRY_HINT = 'The server wants `SENTRY_ACCESS_TOKEN`, which it did not get. Add it under Environment variables for this server and turn on Secret.'

const statuses = (list: McpServerConfig[], stored: ReadonlySet<string>): McpServerStatus[] => list.map((server): McpServerStatus => {
  const base = { id: server.id, tools: [], toolCount: 0 }
  const gone = Object.entries(server.secretEnv ?? {}).filter(([, ref]) => !stored.has(ref)).map(([name]) => name)
  const lost = gone.length > 0 ? { missingSecrets: gone } : {}
  if (!server.enabled) return { ...base, state: 'disabled', ...lost }
  if (gone.length > 0) return { ...base, state: 'failed', error: missingSentence(gone), hint: MISSING_HINT, ...lost }
  switch (server.id) {
    case 'srv-files':
      return { id: server.id, state: 'connected', tools: FILESYSTEM_TOOLS, toolCount: FILESYSTEM_TOOLS.length, server: { name: 'secure-filesystem-server', version: '0.2.0' } }
    case 'srv-github':
      return {
        ...base, state: 'failed',
        error: '`uvx` was not found on PATH.',
        hint: 'Install it, or enter the full path to the program in Command. If you just installed it, restart Cubex so it sees the new PATH.'
      }
    case 'srv-sentry':
      // Once the token is added as a variable, the server is only waiting for a session to start it.
      if ('SENTRY_ACCESS_TOKEN' in { ...server.env, ...server.secretEnv }) return { ...base, state: 'idle' }
      return { ...base, state: 'failed', error: 'The server exited (code 1).', hint: SENTRY_HINT, output: SENTRY_OUTPUT }
    case 'srv-docs':
      return { ...base, state: 'idle', lastTest: { at: Date.now() - 4 * MIN, ok: true, toolCount: 3 } }
    default:
      return { ...base, state: 'idle' }
  }
})

const passed = (name: string): McpTestResult => ({
  ok: true,
  durationMs: 1240,
  server: { name: 'team-docs', version: '1.4.0' },
  protocolVersion: '2025-11-25',
  tools: tools([
    ['search_docs', 'Full-text search across the exported team wiki. Returns titles, paths and short excerpts.'],
    ['get_page', 'Fetch one page by path and return it as Markdown.'],
    ['list_spaces', 'List the wiki spaces that were indexed.']
  ]),
  toolCount: 3,
  output: `${name} index ready: 412 pages from C:\\Users\\dev\\Documents\\Team Wiki\\exports\\2026`
})

const failedTest = (command: string): McpTestResult => {
  if (/exit/.test(command)) {
    return {
      ok: false, durationMs: 380, tools: [], toolCount: 0,
      error: 'The server exited (code 1).',
      hint: 'npm could not find that package. Check its name in Arguments.',
      output: 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@modelcontextprotocol%2fserver-filesytem - Not found\nnpm error 404\nnpm error 404  The requested resource \'@modelcontextprotocol/server-filesytem@*\' could not be found or you do not have permission to access it.'
    }
  }
  const restart = 'If you just installed it, restart Cubex so it sees the new PATH.'
  return {
    ok: false, durationMs: 12, tools: [], toolCount: 0,
    error: `\`${command}\` was not found on PATH.`,
    // The real diagnosis names Node.js only for the programs that ship with it.
    hint: /^(node|npx|npm)$/.test(command)
      ? `Install Node.js, which includes npx and npm, or enter the full path to the program in Command. ${restart}`
      : `Install it, or enter the full path to the program in Command. ${restart}`
  }
}

const hookResult = (event: HookConfig['event'], command: string, matcher: string | undefined): HookTestResult => {
  const tool = matcher?.split('|')[0]?.trim() || 'write_file'
  const payload = JSON.stringify(
    event === 'PreToolUse' || event === 'PostToolUse'
      ? { event, tool_name: tool, tool_input: { path: 'src/example.ts', content: 'export const example = 1\n' }, ...(event === 'PostToolUse' ? { tool_result: 'Sample result from Cubex.' } : {}), cwd: WORKSPACE }
      : event === 'Stop' ? { event, cwd: WORKSPACE } : { event, prompt: 'Add a retry to the upload helper.', cwd: WORKSPACE },
    null, 2
  )
  const base = { event, command, cwd: WORKSPACE, cwdKind: 'project' as const, payload, truncated: false }
  if (/timeout/.test(command)) return { ...base, outcome: 'timed-out', exitCode: null, durationMs: 10_004, stdout: '', stderr: '', decision: 'allowed' }
  if (/block/.test(command)) {
    return {
      ...base, outcome: 'ran', exitCode: 2, durationMs: 212, stdout: '',
      stderr: 'Blocked: scripts/guard-env.mjs does not allow writes to .env files.\nAsk for the change in chat, or edit the file yourself.',
      decision: event === 'PreToolUse' ? 'blocked' : 'allowed',
      reason: 'Blocked: scripts/guard-env.mjs does not allow writes to .env files.\nAsk for the change in chat, or edit the file yourself.',
      ...(event === 'PreToolUse' ? {} : { blockIgnored: true })
    }
  }
  if (/fail/.test(command)) return { ...base, outcome: 'ran', exitCode: 1, durationMs: 340, stdout: '', stderr: 'node:internal/modules/cjs/loader:1228\n  throw err;\n  ^\n\nError: Cannot find module \'C:\\Users\\dev\\code\\lumen-web\\scripts\\guard-env.mjs\'', decision: 'allowed' }
  return { ...base, outcome: 'ran', exitCode: 0, durationMs: 188, stdout: 'checked src/example.ts: no protected paths touched', stderr: '', decision: 'allowed' }
}

export const seed: PreviewSeed = {
  api: (flags) => {
    const mode = flags.get('policy')
    if (mode === null) return {}
    const hold = mode === 'loading'
    const failing = mode === 'error'
    const empty = mode === 'empty'

    let saved = empty ? [] : rules()
    let settings: AppSettings | undefined
    // The credential store: the references that have a value. Sentry's token is configured in `env` mode but not stored.
    const stored = new Set<string>([mcpSecretRef('srv-github', 'GITHUB_TOKEN'), mcpSecretRef('srv-postgres', 'PGPASSWORD')])
    const current = async (): Promise<AppSettings> => {
      if (settings) return settings
      const { SEED_WORKSPACE } = await import('../previewSeed')
      settings = {
        ...DEFAULT_SETTINGS,
        general: { ...DEFAULT_SETTINGS.general, workspacePath: SEED_WORKSPACE, recentWorkspaces: [SEED_WORKSPACE, 'C:\\Users\\dev\\code\\aurora-site'] },
        mcpServers: empty ? [] : servers(mode === 'env'),
        hooks: empty ? [] : hooks()
      }
      return settings
    }

    return {
      listPermissionRules: async (workspace) => {
        if (hold) return new Promise(() => undefined)
        await wait(250)
        if (failing) throw new Error('The saved rules file could not be read: EBUSY, resource busy or locked, open \'C:\\Users\\dev\\AppData\\Roaming\\Cubex\\cubex-data\\permission-rules.json\'.')
        const key = (path: string): string => path.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
        return (workspace ? saved.filter((entry) => key(entry.workspace) === key(workspace)) : saved).map((entry) => ({ ...entry }))
      },
      removePermissionRule: async (id) => {
        await wait(200)
        saved = saved.filter((entry) => entry.id !== id)
      },
      getSettings: async () => current(),
      updateSettings: async (patch) => {
        const next = await current()
        settings = { ...next, ...patch } as AppSettings
        return settings
      },
      getMcpStatus: async () => {
        if (hold) return new Promise(() => undefined)
        if (failing) throw new Error('The connection manager did not answer. Restart Cubex if this keeps happening.')
        return statuses((await current()).mcpServers ?? [], stored)
      },
      testMcpServer: async (request) => {
        await wait(request.command.includes('slow') ? 6000 : 1100)
        const gone = (request.savedSecrets ?? []).filter((name) => !stored.has(mcpSecretRef(request.id ?? '', name)))
        if (gone.length > 0) return { ok: false, durationMs: 4, tools: [], toolCount: 0, error: missingSentence(gone), hint: MISSING_HINT }
        const given = Object.keys({ ...request.env, ...request.secrets }).concat(request.savedSecrets ?? [])
        if ((request.args ?? []).includes('@sentry/mcp-server') && !given.includes('SENTRY_ACCESS_TOKEN')) {
          return { ok: false, durationMs: 410, tools: [], toolCount: 0, error: 'The server exited (code 1).', hint: SENTRY_HINT, output: SENTRY_OUTPUT }
        }
        return /missing|exit/.test(request.command) ? failedTest(request.command) : passed(request.name)
      },
      saveMcpSecret: async ({ serverId, name, value }) => {
        await wait(300)
        if (value.includes('nosave')) {
          return { ok: false, message: 'Cubex keeps secrets in the operating system\'s credential store, and none is available here. On Linux, start a keyring such as GNOME Keyring or KWallet, then try again.' }
        }
        const ref = mcpSecretRef(serverId, name)
        stored.add(ref)
        return { ok: true, ref }
      },
      forgetMcpSecrets: async ({ serverId, names }) => {
        for (const name of names) stored.delete(mcpSecretRef(serverId, name))
      },
      testHook: async (request) => {
        await wait(request.command.includes('slow') ? 6000 : 700)
        if (/busy/.test(request.command)) throw new Error('Other hook tests are still running. Wait for one to finish, then test again.')
        return hookResult(request.event, request.command, request.matcher)
      }
    }
  }
}
