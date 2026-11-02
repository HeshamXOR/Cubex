import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { shell } from 'electron'
import { IPC } from '@shared/ipc'
import { installIsRunning, type AntigravityActionResult, type AntigravityStatus } from '@shared/antigravity'
import { getSettings } from '../config'
import { logger } from '../logger'
import { dataDir } from '../paths'
import { AntigravityInstaller } from '../peers/antigravity/install'
import { antigravityDirectories, parseAuthorizationUrl, type AntigravityDirectories } from '../peers/antigravity/profile'
import { configureAntigravity, validateRuntime, type AntigravityContext } from '../peers/antigravity/runtime'
import { AntigravitySignIn } from '../peers/antigravity/signin'
import { antigravityStatus } from '../peers/antigravity/status'
import { antigravityDesktopApp } from '../peers/appPrograms'
import { peerEnvironment } from '../peers/peerRunner'
import type { IpcContext } from './context'

/** An id the window sends back to name the install or the sign-in it wants to stop: a UUID, so anything long is not one. */
export function parseOperationId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100) throw new Error('That is not an installation or sign-in id.')
  return value
}

const LOCAL_ONLY = 'Local-only mode is on, so nothing is downloaded or started. Turn it off under Privacy to set up Antigravity.'

interface Setup {
  installer: AntigravityInstaller
  signIn: AntigravitySignIn
  directories: AntigravityDirectories
  context: AntigravityContext
  dispose: () => void
}

function refusal(error: unknown): AntigravityActionResult {
  return { ok: false, message: error instanceof Error ? error.message : String(error) }
}

/**
 * Installing Google's Antigravity runtime, signing in to it with a Google account, and the status the Settings page shows. Nothing
 * is built until the first call that needs it, so registering touches neither Electron's app object nor the disk.
 */
export function register(ctx: IpcContext): () => void {
  let setup: Setup | undefined

  function push(): void {
    ctx.send(IPC.antigravityState, status())
  }

  function status(): AntigravityStatus {
    const { installer, signIn, directories } = current()
    return antigravityStatus({
      asset: installer.asset,
      runtime: installer.state,
      signIn: signIn.state,
      profileDirectory: directories.profile,
      desktopApp: antigravityDesktopApp() !== undefined,
      localOnly: getSettings().privacy.localOnly
    })
  }

  function current(): Setup {
    if (setup) return setup
    const base = join(dataDir(), 'antigravity')
    const directories = antigravityDirectories(base)
    // Cubex itself, started as Node, is the program that stands in for a browser while signing in.
    const helperExecutable = process.execPath
    const installer = new AntigravityInstaller({ base, validate: validateRuntime({ helperExecutable, baseEnv: peerEnvironment({}) }) })
    const signIn = new AntigravitySignIn({
      installer,
      helperExecutable,
      // Only ever called with Google's own sign-in page: the runtime's address is checked before it reaches here, and again here.
      open: (url) => { if (parseAuthorizationUrl(url)) void shell.openExternal(url) }
    })
    let installPhase = installer.state.phase
    const stopInstall = installer.subscribe((state) => {
      if (state.phase !== installPhase) {
        installPhase = state.phase
        if (state.phase === 'succeeded') logger.info(`Antigravity runtime ${state.installedVersion ?? ''} installed`.trim())
        else if (state.phase === 'failed') logger.warn(`Antigravity runtime install failed: ${state.message ?? 'no reason given'}`)
      }
      push()
    })
    let signInPhase = signIn.state.phase
    const stopSignIn = signIn.subscribe((state) => {
      if (state.phase !== signInPhase) {
        signInPhase = state.phase
        if (state.phase === 'succeeded') logger.info('Antigravity signed in')
        else if (state.phase === 'failed') logger.warn(`Antigravity sign-in failed: ${state.message ?? 'no reason given'}`)
      }
      push()
    })
    const context: AntigravityContext = { installer, directories, helperExecutable }
    setup = {
      installer, signIn, directories, context,
      dispose: () => { stopInstall(); stopSignIn(); signIn.stop(); installer.stop() }
    }
    return setup
  }

  const localOnly = (): boolean => getSettings().privacy.localOnly

  // A chat can start an Antigravity agent before the Settings page has asked for anything, so the context is there on demand.
  configureAntigravity(() => current().context)

  /**
   * An agent that answered a question stays running for ten quiet minutes, and holds the runtime and the sign-in in memory. The
   * person cannot see it, so removing the runtime or signing out stops it first, and then waits for it to end. What is still
   * running after that is a task the person can see and stop.
   */
  async function stopKeptSessions(): Promise<void> {
    ctx.chat.endAgentSessions('agy-acp')
    await current().installer.whenIdle()
  }

  ctx.handle(IPC.antigravityStatus, (): AntigravityStatus => status())

  // The download takes minutes; the window follows it through pushed state, so this answers as soon as it has begun.
  ctx.handle(IPC.antigravityInstall, (): AntigravityActionResult => {
    if (localOnly()) return { ok: false, message: LOCAL_ONLY }
    const { installer } = current()
    if (installIsRunning(installer.state)) return { ok: true, message: 'The runtime is already being installed.' }
    try {
      installer.start()
      return { ok: true, message: 'Downloading Google\'s Antigravity runtime.' }
    } catch (error) {
      return refusal(error)
    }
  })

  ctx.handle(IPC.antigravityCancelInstall, (operationId?: unknown): AntigravityActionResult => {
    const id = parseOperationId(operationId)
    try {
      current().installer.cancel(id)
      return { ok: true, message: 'Cancelling the installation.' }
    } catch (error) {
      return refusal(error)
    }
  })

  ctx.handle(IPC.antigravityRemove, async (): Promise<AntigravityActionResult> => {
    const { installer, signIn, directories } = current()
    if (signIn.busy) return { ok: false, message: 'Finish or cancel the sign-in first, then remove the runtime.' }
    await stopKeptSessions()
    try {
      installer.remove()
    } catch (error) {
      return refusal(error)
    }
    // The sign-in lives in a profile that is Cubex's own, and it belongs to the runtime: it goes with it.
    try {
      for (const directory of [directories.profile, directories.temp]) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {
      push()
      return { ok: false, message: `The runtime was removed, but its saved Google sign-in could not be deleted. Delete the folder ${directories.profile} yourself.` }
    }
    push()
    return { ok: true, message: 'The Antigravity runtime and its sign-in were removed.' }
  })

  ctx.handle(IPC.antigravitySignIn, (): AntigravityActionResult => {
    if (localOnly()) return { ok: false, message: LOCAL_ONLY }
    const { installer, signIn } = current()
    try {
      if (!installer.resolve()) return { ok: false, message: 'Install the Antigravity runtime first.' }
      signIn.start()
      return { ok: true, message: 'Starting Google sign-in.' }
    } catch (error) {
      return refusal(error)
    }
  })

  ctx.handle(IPC.antigravityCancelSignIn, (flowId?: unknown): AntigravityActionResult => {
    const id = parseOperationId(flowId)
    try {
      current().signIn.cancel(id)
      return { ok: true, message: 'Google sign-in was cancelled.' }
    } catch (error) {
      return refusal(error)
    }
  })

  ctx.handle(IPC.antigravityOpenSignIn, (): AntigravityActionResult => {
    const url = current().signIn.state.authorizationUrl
    if (!url || !parseAuthorizationUrl(url)) return { ok: false, message: 'There is no Google sign-in page to open. Start signing in again.' }
    void shell.openExternal(url)
    return { ok: true, message: 'Google\'s sign-in page opened in your browser.' }
  })

  ctx.handle(IPC.antigravitySignOut, async (): Promise<AntigravityActionResult> => {
    if (localOnly()) return { ok: false, message: LOCAL_ONLY }
    await stopKeptSessions()
    const result = await current().signIn.signOut()
    push()
    return result
  })

  return () => {
    setup?.dispose()
    setup = undefined
    configureAntigravity(undefined)
  }
}
