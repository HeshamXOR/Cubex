import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * What Google's Antigravity runtime is given to run in: a private profile of its own, an environment without any other login,
 * and a way to tell Cubex where its Google sign-in page is instead of opening a browser by itself. Ported from the T3 Code
 * project (github.com/pingdotgg/t3code, MIT licence, Copyright (c) 2026 T3 Tools Inc.); see THIRD_PARTY_NOTICES.md.
 *
 * The profile is the runtime's GEMINI_HOME. Its Google sign-in is saved there, as a file the runtime owns; Cubex checks that the
 * file is there and never opens it. Nothing of the person's own `~/.gemini`, or of the Antigravity desktop app, is used.
 */

export const AUTH_STDOUT_PREFIX = 'Open the following link to authenticate the ACP server: '
/** What the browser helper prints to its error output, followed by the address as a JSON string. */
export const AUTH_BROWSER_MARKER = '__CUBEX_ANTIGRAVITY_AUTH_URL__'
export const SIGN_IN_FIRST = 'Antigravity is not signed in.'
export const SIGN_IN_FIRST_HINT = 'Open Settings, find Antigravity under "Found on this PC", and choose "Sign in with Google".'
/** What the runtime reported as its sign-in page was not Google's, so nothing was opened. */
export const SIGN_IN_PAGE_REFUSED = 'Antigravity asked for a sign-in page that is not Google\'s, so Cubex did not open it.'
export const SIGN_IN_PAGE_REFUSED_HINT = 'Remove the runtime under "Found on this PC" and install it again.'

const MAX_AUTHORIZATION_URL = 16_384

/** The variables that would point the runtime at some other login, or change where it keeps its own. */
const REMOVED_ENVIRONMENT = new Set([
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_QUOTA_PROJECT', 'GOOGLE_GENAI_USE_VERTEXAI', 'GCLOUD_PROJECT', 'CLOUDSDK_CORE_PROJECT', 'AGY_ACP_CCPA_PROJECT',
  'AGY_ACP_ENABLE_OAUTH', 'GEMINI_HOME', 'AGY_ACP_FORCE_FILE_STORAGE', 'ANTIGRAVITY_HARNESS_PATH', 'BROWSER', 'PYTHONUNBUFFERED',
  'ELECTRON_RUN_AS_NODE'
])

export interface AntigravityDirectories {
  /** Where the runtime Cubex installed lives. */
  managed: string
  /** The runtime's GEMINI_HOME. */
  profile: string
  /** Where each run of the runtime unpacks itself. Short, so what it unpacks stays under the path limit Windows has. */
  temp: string
}

/** The folders Cubex uses for Antigravity, under one folder it owns. The names are short on purpose: the runtime unpacks members 120 characters deep. */
export function antigravityDirectories(base: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): AntigravityDirectories {
  return {
    managed: join(base, 'runtime', `${platform}-${arch}`),
    profile: join(base, 'profile'),
    temp: join(base, 'tmp')
  }
}

export interface AntigravityProfile {
  platform: NodeJS.Platform
  geminiHome: string
  acpDirectory: string
  /** The file the runtime saves the Google sign-in in. Cubex asks whether it is there and never reads it. */
  tokenPath: string
  /** The parent of the folders each run unpacks into. */
  tempDirectory: string
  /** What BROWSER is set to: a command that reports the address instead of opening it. */
  browserCommand: string
}

// --- Telling Cubex where the sign-in page is --------------------------------------------------

/**
 * The runtime opens the sign-in page the way Python does, with the BROWSER variable, so BROWSER is a small Node program that
 * prints the address to its error output and does nothing else. Python splits BROWSER on the platform's path separator before it
 * reads quotes, so this source has neither a colon nor a semicolon in it.
 */
const BROWSER_HELPER_SOURCE =
  `process.stderr.on("error",()=>process.exit(0)).write("${AUTH_BROWSER_MARKER}"+JSON.stringify(process.argv[1])+"\\n",()=>process.exit(0))`

const BROWSER_PREFLIGHT_URL = 'https://example.invalid/cubex-antigravity-browser-preflight'

function quoteArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/** The BROWSER command for a program that can run Node's `-e`, or undefined when its path cannot be put in one. */
export function browserCommand(helperExecutable: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const executable = platform === 'win32' ? helperExecutable.replaceAll('\\', '/') : helperExecutable
  const command = [executable, '-e', BROWSER_HELPER_SOURCE, '--', '%s'].map(quoteArgument).join(' ')
  if (command.includes(platform === 'win32' ? ';' : ':') || /[\r\n\0]/.test(executable) || executable.includes('%s')) return undefined
  return command
}

/** Whether a program, run as the BROWSER command would run it, reports an address and exits: so that no browser is opened by mistake. */
export function browserHelperWorks(helperExecutable: string, env: NodeJS.ProcessEnv): boolean {
  try {
    const run = spawnSync(helperExecutable, ['-e', BROWSER_HELPER_SOURCE, '--', BROWSER_PREFLIGHT_URL], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 5_000,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return run.status === 0 && run.stdout === '' && run.stderr === `${AUTH_BROWSER_MARKER}${JSON.stringify(BROWSER_PREFLIGHT_URL)}\n`
  } catch {
    return false
  }
}

export interface AuthorizationRequest {
  authorizationUrl: string
  redirectUri: string
  state: string
}

/**
 * Reads the address of Google's sign-in page that the runtime reported, and accepts only what it should be: Google's own page
 * for the code flow, with a return address on this computer. Anything else is not opened, whatever the runtime says.
 */
export function parseAuthorizationUrl(text: string): AuthorizationRequest | undefined {
  if (text.length > MAX_AUTHORIZATION_URL || /\s/.test(text)) return undefined
  let url: URL
  try { url = new URL(text) } catch { return undefined }
  const state = url.searchParams.get('state')
  const redirectUri = url.searchParams.get('redirect_uri')
  if (
    url.origin !== 'https://accounts.google.com' ||
    url.pathname !== '/o/oauth2/v2/auth' ||
    url.username !== '' || url.password !== '' || url.hash !== '' ||
    url.searchParams.getAll('state').length !== 1 ||
    url.searchParams.getAll('redirect_uri').length !== 1 ||
    url.searchParams.getAll('response_type').length !== 1 ||
    url.searchParams.get('response_type') !== 'code' ||
    state === null || state.length === 0 || state.length > 512 || /\s/.test(state) ||
    redirectUri === null || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/.test(redirectUri)
  ) return undefined
  let redirect: URL
  try { redirect = new URL(redirectUri) } catch { return undefined }
  if (Number(redirect.port) < 1_024) return undefined
  // The address as it was parsed, not as it was written: a quote or a bracket in it is encoded before the system opens it.
  return { authorizationUrl: url.href, redirectUri, state }
}

/** The address in a line the runtime printed, from either way it prints it, or undefined when the line is not about signing in. */
export function authorizationUrlIn(line: string): { found: true; request: AuthorizationRequest | undefined } | { found: false } {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line
  if (text.startsWith(AUTH_STDOUT_PREFIX)) return { found: true, request: parseAuthorizationUrl(text.slice(AUTH_STDOUT_PREFIX.length)) }
  if (text.startsWith(AUTH_BROWSER_MARKER)) {
    let decoded: unknown
    try { decoded = JSON.parse(text.slice(AUTH_BROWSER_MARKER.length)) } catch { return { found: true, request: undefined } }
    return { found: true, request: typeof decoded === 'string' ? parseAuthorizationUrl(decoded) : undefined }
  }
  return { found: false }
}

// --- The environment and the profile ----------------------------------------------------------

/** The settings file of the profile. It names the sign-in method and holds no credential. */
export const PROFILE_SETTINGS = `${JSON.stringify({ auth: { type: 'oauth-personal' } })}\n`

/**
 * The environment the runtime starts with: the one Cubex gives any program, without any other login the person's environment
 * may carry, with its own profile and temporary folder, and with the helper in place of a browser.
 */
export function antigravityEnvironment(profile: AntigravityProfile, base: NodeJS.ProcessEnv, runtimeTemp?: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  // Windows treats names as the same whatever their case, so a variable is removed whatever its case.
  for (const [key, value] of Object.entries(base)) if (!REMOVED_ENVIRONMENT.has(key.toUpperCase())) environment[key] = value
  const temp = runtimeTemp ?? profile.tempDirectory
  return {
    ...environment,
    GEMINI_HOME: profile.geminiHome,
    AGY_ACP_FORCE_FILE_STORAGE: '1',
    BROWSER: profile.browserCommand,
    PYTHONUNBUFFERED: '1',
    ELECTRON_RUN_AS_NODE: '1',
    ...(profile.platform === 'win32' ? { TEMP: temp, TMP: temp } : { TMPDIR: temp })
  }
}

export interface PrepareProfileInput {
  /** The folder that becomes GEMINI_HOME. */
  profileDirectory: string
  /** The parent of the folders each run unpacks into. */
  tempDirectory: string
  /** A program that can run Node's `-e`: Cubex itself with ELECTRON_RUN_AS_NODE, or Node. */
  helperExecutable: string
  platform?: NodeJS.Platform
  baseEnv?: NodeJS.ProcessEnv
}

export class ProfileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProfileError'
  }
}

/** Makes the profile's folders and writes its settings, after checking that the browser helper does what it is trusted to. */
export function prepareProfile(input: PrepareProfileInput): AntigravityProfile {
  const platform = input.platform ?? process.platform
  const baseEnv = input.baseEnv ?? process.env
  const command = browserCommand(input.helperExecutable, platform)
  if (!command) throw new ProfileError('The path of Cubex cannot be used to keep Antigravity from opening a browser by itself.')
  if (!browserHelperWorks(input.helperExecutable, baseEnv)) throw new ProfileError('Cubex could not check that Antigravity will not open a browser by itself.')
  const geminiHome = resolve(input.profileDirectory)
  const acpDirectory = join(geminiHome, 'antigravity-acp')
  const tempDirectory = resolve(input.tempDirectory)
  for (const directory of [geminiHome, acpDirectory, tempDirectory]) {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
    } catch (error) {
      throw new ProfileError(`The Antigravity folder ${directory} could not be created: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    // Written on every start, so what it says is always what this version of Cubex means.
    writeFileSync(join(acpDirectory, 'settings.json'), PROFILE_SETTINGS)
  } catch (error) {
    throw new ProfileError(`The Antigravity profile settings could not be written: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { platform, geminiHome, acpDirectory, tokenPath: join(acpDirectory, 'acp_token.json'), tempDirectory, browserCommand: command }
}

/** Whether the runtime has saved a sign-in: the file is there. Its contents are the runtime's, and Cubex never reads them. */
export function hasSavedSignIn(profileDirectory: string): boolean {
  try {
    return statSync(join(resolve(profileDirectory), 'antigravity-acp', 'acp_token.json')).isFile()
  } catch {
    return false
  }
}

/** Where the profile's sign-in is saved, without making the profile. */
export function tokenPathOf(profileDirectory: string): string {
  return join(resolve(profileDirectory), 'antigravity-acp', 'acp_token.json')
}

/** The folder each run unpacks into is removed with its run. What a killed run left behind is removed when none is running. */
export function removeRuntimeTemp(directory: string): void {
  try { rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* a handle can outlive the process on Windows: the next sweep gets it */ }
}

export function sweepRuntimeTemp(root: string): void {
  let names: string[]
  try { names = readdirSync(root) } catch { return }
  for (const name of names) if (name.startsWith('run-')) removeRuntimeTemp(join(root, name))
}
