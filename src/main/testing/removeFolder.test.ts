import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeFolder } from './removeFolder'

const holders: ChildProcess[] = []
const made: string[] = []

const folder = (): string => {
  const path = realpathSync.native(mkdtempSync(join(tmpdir(), 'cubex-remove-folder-')))
  made.push(path)
  return path
}

/** A folder with a program in it that keeps the folder inside it as its working directory until it is stopped. */
async function held(): Promise<{ root: string; holder: ChildProcess }> {
  const root = folder()
  const inside = join(root, 'inside')
  mkdirSync(inside)
  const holder = spawn(process.execPath, ['-e', 'process.stdout.write("up"); setInterval(() => {}, 1000)'], { cwd: inside, stdio: ['ignore', 'pipe', 'ignore'] })
  holders.push(holder)
  await new Promise<void>((resolve, reject) => {
    holder.once('error', reject)
    holder.stdout!.once('data', () => resolve())
  })
  return { root, holder }
}

afterEach(async () => {
  for (const holder of holders.splice(0)) {
    if (holder.exitCode !== null || holder.signalCode !== null) continue
    const gone = new Promise<void>((resolve) => holder.once('exit', () => resolve()))
    holder.kill()
    await gone
  }
  for (const path of made.splice(0)) await removeFolder(path)
})

describe('removeFolder', () => {
  it('removes a folder and what is in it', async () => {
    const root = folder()
    mkdirSync(join(root, 'a', 'b'), { recursive: true })
    writeFileSync(join(root, 'a', 'b', 'file.txt'), 'x')
    await removeFolder(root)
    expect(existsSync(root)).toBe(false)
  })

  it('waits for a program that lets go of the folder a moment later', async () => {
    const { root, holder } = await held()
    const timer = setTimeout(() => holder.kill(), 600)
    try {
      await removeFolder(root)
    } finally {
      clearTimeout(timer)
    }
    expect(existsSync(root)).toBe(false)
  })
})
