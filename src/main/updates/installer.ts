import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { win32 } from 'node:path'

/** What decides whether this copy can replace itself. */
export interface InstallFacts {
  platform: NodeJS.Platform
  /** False when running from source with `electron .` or the dev server. */
  packaged: boolean
  /** The running executable. */
  execPath: string
}

export interface InstallSupport {
  canInstall: boolean
  /** When it cannot: why, in a sentence. */
  reason?: string
}

/** The program the Cubex installer writes beside the application. Only a copy set up by the installer has it. */
const UNINSTALLER = 'Uninstall Cubex.exe'

/**
 * Whether this copy can run a downloaded installer over itself. Only the Windows installer's own copy can: an
 * unpacked folder or a portable copy has no uninstaller beside it and no registry entry the installer would update,
 * and the other platforms have no installer to run yet. Those copies are sent to the release page instead.
 */
export function installSupport(facts: InstallFacts, exists: (path: string) => boolean): InstallSupport {
  if (!facts.packaged) return { canInstall: false, reason: 'This copy runs from source, so it cannot update itself.' }
  if (facts.platform !== 'win32') return { canInstall: false, reason: 'Cubex installs updates by itself on Windows only. Download the new version from the release page.' }
  if (!exists(win32.join(win32.dirname(facts.execPath), UNINSTALLER))) {
    return { canInstall: false, reason: 'This copy was not set up with the Cubex installer, so it cannot update itself. Download the installer from the release page.' }
  }
  return { canInstall: true }
}

/**
 * The arguments electron-updater gives an electron-builder NSIS installer, and what each does there (read in
 * `app-builder-lib/templates/nsis`):
 *  - `--updated` marks the run as an update: the installer waits for the running Cubex to exit instead of asking the
 *    person to close it, keeps the shortcuts and settings, and starts the app with `--updated` afterwards
 *    (`include/allowOnlyOneInstallerInstance.nsh`, `common.nsh`).
 *  - `/S` runs the installer without windows. The folder is not passed: a per-user install reads `InstallLocation`
 *    from its own registry key, so the update goes where Cubex already is (`multiUser.nsh`).
 *  - `--force-run` starts Cubex again when the installer ends. The assisted installer would otherwise do that only
 *    from the finish page, which a silent run never shows (`installSection.nsh`).
 */
export const INSTALLER_ARGUMENTS: readonly string[] = ['--updated', '/S', '--force-run']

type SpawnImpl = (command: string, args: readonly string[], options: SpawnOptions) => Pick<ChildProcess, 'once' | 'on' | 'unref'>

/**
 * Starts the installer apart from this process, so it keeps running when Cubex quits, and resolves once it has
 * really started. The caller quits only after that: a failure to start must leave Cubex open.
 */
export function startInstaller(path: string, spawnImpl: SpawnImpl = spawn): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<SpawnImpl>
    try {
      child = spawnImpl(path, INSTALLER_ARGUMENTS, { detached: true, stdio: 'ignore', windowsHide: true })
    } catch (error) {
      reject(error)
      return
    }
    child.once('error', reject)
    child.once('spawn', () => {
      // After this point an error is the installer's own business; it must not take Cubex down while it quits.
      child.on('error', () => undefined)
      child.unref()
      resolve()
    })
  })
}
