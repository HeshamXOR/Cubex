import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import type { AcpPeer } from '@shared/peers'
import { LaunchError, locateCommand, resolveLaunch, type LaunchInput, type LaunchPlan } from '../../mcp/resolveLaunch'
import { AcpClosedError, AcpConnection, AcpRequestError } from '../acp/connection'
import { AcpFailure } from '../acp/failure'
import { isRecord } from '../acp/lines'
import { fromChild, type AcpProcess } from '../acp/process'
import type { AcpStart, StartInput } from '../acp/starters'
import { peerEnvironment } from '../peerRunner'
import { AntigravityFilter } from './filter'
import { AntigravityInstaller, InstallError, type AntigravityExecutable } from './install'
import { antigravityEnvironment, hasSavedSignIn, prepareProfile, ProfileError, removeRuntimeTemp, sweepRuntimeTemp, type AntigravityDirectories, type AuthorizationRequest } from './profile'
import { antigravityProgramNames } from './release'

/**
 * Starting Google's Antigravity runtime for an agent of the preset "agy-acp": the runtime Cubex installed, or one the person
 * pointed at, started in a private profile and an environment that has no other login, and wrapped in the filter that keeps it
 * from asking for a sign-in inside a chat. Ported from the T3 Code project (github.com/pingdotgg/t3code, MIT licence, Copyright
 * (c) 2026 T3 Tools Inc.); see THIRD_PARTY_NOTICES.md.
 */

/** What the preset's command is when the person has not pointed it anywhere: the name Google gives the runtime. */
export const DEFAULT_RUNTIME_COMMAND = 'agy_acp_server'

export interface AntigravityContext {
  installer: AntigravityInstaller
  directories: AntigravityDirectories
  /** A program that can run Node's `-e`: Cubex itself, started with ELECTRON_RUN_AS_NODE, or Node. */
  helperExecutable: string
}

let context: AntigravityContext | undefined
let provider: (() => AntigravityContext) | undefined

/**
 * The main process says where Antigravity's files are and what installs it. Without it no Antigravity agent can start. It may
 * pass a function instead, which is called the first time the context is needed: the folders are not known until the app is ready.
 */
export function configureAntigravity(next: AntigravityContext | (() => AntigravityContext) | undefined): void {
  context = typeof next === 'function' ? undefined : next
  provider = typeof next === 'function' ? next : undefined
}

export function antigravityContext(): AntigravityContext | undefined {
  if (!context && provider) context = provider()
  return context
}

const NOT_INSTALLED_HINT = 'Open Settings, find Antigravity under "Found on this PC", and choose "Install the runtime".'

/**
 * The runtime to start: a program the person pointed the agent at, else the one Cubex installed, else one on PATH. A program
 * found any other way than by Cubex's own install needs its harness beside it.
 */
export function resolveRuntime(peer: Pick<AcpPeer, 'command'>, installer: AntigravityInstaller, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): AntigravityExecutable {
  const names = antigravityProgramNames(platform)
  const override = peer.command.trim()
  try {
    if (override && override !== DEFAULT_RUNTIME_COMMAND) {
      const candidate = isAbsolute(override) || override.includes('/') || override.includes('\\') ? resolvePath(override) : locateCommand({ command: override, env })
      const found = candidate ? installer.fromExternal(candidate, 'override') : undefined
      if (!found) throw new AcpFailure(`The Antigravity runtime "${override}" was not found, or the program ${names.harness} is not beside it.`, { hint: 'Clear the program under Edit to use the one Cubex installs.' })
      return found
    }
    const managed = installer.resolve()
    if (managed) return managed
    const onPath = locateCommand({ command: names.executable, env })
    const found = onPath ? installer.fromExternal(onPath, 'path') : undefined
    if (found) return found
  } catch (error) {
    if (error instanceof AcpFailure) throw error
    throw new AcpFailure(error instanceof Error ? error.message : 'Could not read the Antigravity installation.', { hint: 'Remove the Antigravity runtime in Settings and install it again.' })
  }
  throw new AcpFailure(
    installer.asset ? 'Antigravity is not installed.' : `Google does not publish an Antigravity runtime for ${platform}-${process.arch}.`,
    installer.asset ? { hint: NOT_INSTALLED_HINT } : { hint: 'Use a computer Google supports, or point the agent at a runtime under Edit.' }
  )
}

/**
 * Where the runtime of an Antigravity agent is, or why there is none, without starting anything: for the lists that say which agents
 * can be used on this computer.
 */
export function runtimeLocation(peer: Pick<AcpPeer, 'command'>, env: NodeJS.ProcessEnv): { path: string } | { problem: string } {
  const configured = antigravityContext()
  if (!configured) return { problem: 'Antigravity is not set up in this build of Cubex.' }
  try {
    return { path: resolveRuntime(peer, configured.installer, env).executablePath }
  } catch (error) {
    return { problem: error instanceof Error ? error.message : 'The Antigravity runtime could not be read.' }
  }
}

/** How many runs are going, so what an earlier crash left in the temporary folder is only swept when none is. */
let activeRuns = 0
export interface SpawnedRuntime {
  process: AcpProcess
  /** Releases what the run holds and removes its temporary folder. Call it when the run is over. */
  cleanup: () => void
  executable: AntigravityExecutable
}

export interface SpawnInput {
  executable: AntigravityExecutable
  /** The folder the runtime's profile (its GEMINI_HOME) is. */
  profileDirectory: string
  tempDirectory: string
  helperExecutable: string
  cwd: string
  baseEnv: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  launch?: ((input: LaunchInput) => LaunchPlan) | undefined
  installer?: AntigravityInstaller
}

/** Starts the runtime in a profile, with its environment and a temporary folder of its own for this run. */
export function spawnRuntime(input: SpawnInput): SpawnedRuntime {
  const platform = input.platform ?? process.platform
  let profile: ReturnType<typeof prepareProfile>
  try {
    profile = prepareProfile({ profileDirectory: input.profileDirectory, tempDirectory: input.tempDirectory, helperExecutable: input.helperExecutable, platform, baseEnv: input.baseEnv })
  } catch (error) {
    if (error instanceof ProfileError) throw new AcpFailure(error.message)
    throw error
  }
  if (activeRuns === 0) sweepRuntimeTemp(profile.tempDirectory)
  const runTemp = mkdtempSync(join(profile.tempDirectory, 'run-'))
  const env = { ...antigravityEnvironment(profile, input.baseEnv, runTemp), ANTIGRAVITY_HARNESS_PATH: input.executable.harnessPath }
  const release = input.installer?.lease(input.executable) ?? (() => undefined)
  let finished = false
  const cleanup = (): void => {
    if (finished) return
    finished = true
    activeRuns--
    release()
    removeRuntimeTemp(runTemp)
  }
  activeRuns++
  try {
    const plan = (input.launch ?? resolveLaunch)({ command: input.executable.executablePath, args: platform === 'linux' ? ['--uid='] : [], cwd: input.cwd, env })
    const child = spawn(plan.file, plan.args, {
      cwd: input.cwd,
      env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      // On POSIX the runtime leads its own group, so stopping it stops what it started too.
      detached: platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    return { process: fromChild(child), cleanup, executable: input.executable }
  } catch (error) {
    cleanup()
    if (error instanceof LaunchError) throw new AcpFailure(error.message)
    throw new AcpFailure(`Antigravity could not be started: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export interface AntigravityStartOptions {
  /** Signing in: the address of Google's sign-in page goes here, and the runtime goes on waiting. */
  onAuthorizationUrl?: (request: AuthorizationRequest) => void
  /** Called once when the runtime is gone and what its run held is given up: its folder and its place in the release it runs from. */
  onGone?: () => void
}

/** The starter for the preset, with what signing in adds. */
export function startAntigravityWith(input: StartInput, options: AntigravityStartOptions = {}): AcpProcess {
  const configured = antigravityContext()
  if (!configured) throw new AcpFailure('Antigravity is not set up in this build of Cubex.')
  const env = peerEnvironment(input.peer, input.env)
  const executable = resolveRuntime(input.peer, configured.installer, env)
  const spawned = spawnRuntime({
    executable,
    profileDirectory: configured.directories.profile,
    tempDirectory: configured.directories.temp,
    helperExecutable: configured.helperExecutable,
    cwd: input.cwd,
    baseEnv: env,
    launch: input.launch,
    installer: configured.installer
  })
  return new AntigravityFilter({
    runtime: spawned.process,
    name: input.peer.name,
    signedIn: () => hasSavedSignIn(configured.directories.profile),
    ...(options.onAuthorizationUrl ? { onAuthorizationUrl: options.onAuthorizationUrl } : {}),
    cleanup: () => {
      try { spawned.cleanup() } finally { options.onGone?.() }
    }
  }).process
}

export const startAntigravity: AcpStart = (input) => startAntigravityWith(input)

// --- Talking to the runtime directly -------------------------------------------------------

export interface RuntimeSessionOptions {
  executable: AntigravityExecutable
  profileDirectory: string
  tempDirectory: string
  helperExecutable: string
  baseEnv: NodeJS.ProcessEnv
  launch?: ((input: LaunchInput) => LaunchPlan) | undefined
  installer?: AntigravityInstaller
  signal?: AbortSignal
  timeoutMs: number
}

/**
 * Starts the runtime, hands `work` a connection to it, and stops it afterwards, whatever `work` did. For the checks that need an
 * answer from the runtime and not a chat: that a download is the release, and signing out.
 */
export async function withRuntime<T>(options: RuntimeSessionOptions, work: (connection: AcpConnection) => Promise<T>): Promise<T> {
  const folder = mkdtempSync(join(tmpdir(), 'cubex-agy-run-'))
  const spawned = spawnRuntime({
    executable: options.executable,
    profileDirectory: options.profileDirectory,
    tempDirectory: options.tempDirectory,
    helperExecutable: options.helperExecutable,
    cwd: folder,
    baseEnv: options.baseEnv,
    launch: options.launch,
    ...(options.installer ? { installer: options.installer } : {})
  })
  const { process: runtime } = spawned
  let closed: AcpClosedError | undefined
  let ended!: () => void
  const exited = new Promise<void>((resolve) => { ended = resolve })
  runtime.stderr?.on('data', () => undefined)
  runtime.stderr?.on('error', () => undefined)
  runtime.stdin?.on('error', () => undefined)
  const connection = new AcpConnection(runtime.stdout!, runtime.stdin!, {
    onNotification: () => undefined,
    onRequest: () => Promise.reject(new AcpRequestError(-32601, 'Not supported here.'))
  })
  runtime.once('error', (error) => { closed = new AcpClosedError(error.message, undefined, error.code); connection.close(closed); ended() })
  runtime.once('close', (code) => { closed = new AcpClosedError('The runtime ended.', code); connection.close(closed); ended() })
  const stop = (): void => runtime.stop(false)
  const onAbort = (): void => stop()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(stop, options.timeoutMs)
  try {
    return await work(connection)
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    stop()
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000).unref?.())])
    spawned.cleanup()
    try { rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* swept with the temporary folder */ }
  }
}

/** The handshake's answer, checked against what the release the person is installing says about itself. */
export function isExpectedRelease(init: unknown, expectedVersion: string): boolean {
  if (!isRecord(init)) return false
  const info = isRecord(init.agentInfo) ? init.agentInfo : {}
  const capabilities = isRecord(init.agentCapabilities) ? init.agentCapabilities : {}
  const sessions = isRecord(capabilities.sessionCapabilities) ? capabilities.sessionCapabilities : {}
  const auth = isRecord(capabilities.auth) ? capabilities.auth : {}
  const methods = Array.isArray(init.authMethods) ? init.authMethods : []
  return (
    info.name === 'antigravity-acp' &&
    info.version === expectedVersion &&
    // Version 1.1.1 can report 2 with the first version's shape of answer.
    (init.protocolVersion === 1 || init.protocolVersion === 2) &&
    capabilities.loadSession === true &&
    Boolean(sessions.resume) &&
    Boolean(auth.logout) &&
    methods.some((method) => isRecord(method) && (method.id === 'oauth-personal' || method.methodId === 'oauth-personal'))
  )
}

export interface ValidateOptions {
  helperExecutable: string
  baseEnv: NodeJS.ProcessEnv
  launch?: ((input: LaunchInput) => LaunchPlan) | undefined
  timeoutMs?: number
}

/** Starts a downloaded runtime in a profile of its own and checks that it says it is the release that was asked for. */
export function validateRuntime(options: ValidateOptions): (executable: AntigravityExecutable, expectedVersion: string, signal: AbortSignal) => Promise<void> {
  return async (executable, expectedVersion, signal) => {
    // A shallow folder: what the runtime unpacks is deep, and Windows has a limit on how long a path may be.
    const folder = mkdtempSync(join(tmpdir(), 'cubex-agy-check-'))
    try {
      await withRuntime({
        executable,
        profileDirectory: join(folder, 'p'),
        tempDirectory: join(folder, 't'),
        helperExecutable: options.helperExecutable,
        baseEnv: options.baseEnv,
        launch: options.launch,
        signal,
        timeoutMs: options.timeoutMs ?? 90_000
      }, async (connection) => {
        const init = await connection.request('initialize', {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'cubex', title: 'Cubex', version: '0.0.0' }
        })
        if (!isExpectedRelease(init, expectedVersion)) throw new InstallError('The downloaded runtime did not identify as the expected Google Antigravity release.', 'verify')
      })
    } finally {
      try { rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* swept with the temporary folder */ }
    }
  }
}
