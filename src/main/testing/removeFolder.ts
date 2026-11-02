import { rm } from 'node:fs/promises'

/** How many more times a folder is tried. The wait grows by 100 ms each time, so this is about eight seconds in all, inside the ten a hook is given. */
const RETRIES = 12

/**
 * Removes a folder a test made, for a test that started programs. A program that was stopped a moment ago can still hold its working
 * directory for a while on Windows, and the removal then fails with EBUSY. `rmSync` does not try that error again whatever it is told
 * and `rm` does, so this waits for the program to let go. A folder that is held for longer is left to the system's cleanup of its
 * temporary folder: the test it belongs to has already passed or failed on its own account.
 */
export async function removeFolder(path: string, retries: number = RETRIES): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true, maxRetries: retries, retryDelay: 100 })
  } catch {
    /* left to the system */
  }
}
