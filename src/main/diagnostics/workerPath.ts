import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The names the worker chunk may be emitted under, in the order they are tried. */
const WORKER_FILES = ['tsWorker.js', 'tsWorker.mjs', 'tsWorker.cjs']

/**
 * The built checker worker, which electron-vite emits beside the main bundle. `bundleDir` is the folder of the
 * running bundle: `out/main` in development and `resources/app.asar/out/main` once packaged.
 *
 * A packaged app keeps the worker inside app.asar. Electron reads files from an archive transparently and a
 * worker thread loads its script the same way (an ESM worker started from an asar was checked on Electron 33),
 * so nothing is unpacked and the path is simply the one beside the bundle. From source, such as under vitest,
 * there is no built worker and this returns undefined.
 */
export function resolveWorkerPath(bundleDir: string, exists: (path: string) => boolean = existsSync): string | undefined {
  for (const name of WORKER_FILES) {
    const candidate = join(bundleDir, name)
    if (exists(candidate)) return candidate
  }
  return undefined
}

/**
 * The folder that holds the app's package.json, found by walking up from the main bundle: the repository root in
 * development, `app.asar` once packaged. It is where a typescript package installed with the app would be found.
 */
export function findAppDir(bundleDir: string, exists: (path: string) => boolean = existsSync): string {
  let dir = bundleDir
  for (;;) {
    if (exists(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return bundleDir
    dir = parent
  }
}
