import { SAFE_GIT_ENV } from './tools/shellReadOnly'

/**
 * Child processes (shell commands, hooks, MCP servers) must not inherit Cubex's
 * own provider credentials. Users who need a key in a child can export it in
 * their shell profile, or set it explicitly on the MCP server entry.
 * Windows env names are case-insensitive, hence the `i` flag.
 */
const SECRET_ENV = /^(?:CUBEX_.*|.*_KEY|.*_SECRET(?:_KEY)?|.*_TOKEN|.*_PASSWORD|.*_PAT|.*_CREDENTIALS?|DATABASE_URL|ANTHROPIC_.*|OPENAI_.*)$/i

const NON_INTERACTIVE_ENV: NodeJS.ProcessEnv = {
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
  GH_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0'
}

export function childEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) if (!SECRET_ENV.test(key)) env[key] = value
  // Windows: never resolve a bare program name from the current (workspace) directory.
  return { ...env, ...SAFE_GIT_ENV, ...NON_INTERACTIVE_ENV, ...(process.platform === 'win32' ? { NoDefaultCurrentDirectoryInExePath: '1' } : {}) }
}
