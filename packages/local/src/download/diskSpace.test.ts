import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkFreeSpace, formatSize, nearestExistingDir, shortfallMessage, volumeLabel } from './diskSpace'

const GB = 1024 ** 3
const MB = 1024 ** 2

describe('formatSize', () => {
  it('rounds the way the rest of the app does', () => {
    expect(formatSize(4.9 * GB)).toBe('4.9 GB')
    expect(formatSize(19 * GB)).toBe('19 GB')
    expect(formatSize(274 * MB)).toBe('274 MB')
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(-5)).toBe('0 B')
  })
})

describe('volumeLabel', () => {
  it('names a Windows drive by its letter, whatever machine asks', () => {
    expect(volumeLabel('C:\\Users\\a\\.ollama\\models', 'win32')).toBe('C:')
    expect(volumeLabel('d:\\models', 'win32')).toBe('D:')
  })

  it('names any other disk by the folder on it', () => {
    expect(volumeLabel('/home/a/.ollama/models', 'linux')).toBe('the disk holding /home/a/.ollama/models')
    expect(volumeLabel('\\\\server\\share\\models', 'win32')).toContain('the disk holding')
  })
})

describe('shortfallMessage', () => {
  const base = { volume: 'C:', reserveBytes: 512 * MB }

  it('says what the model needs and what the disk has', () => {
    expect(shortfallMessage({ ...base, requiredBytes: 4.9 * GB, freeBytes: 2.1 * GB })).toBe(
      'This model needs about 4.9 GB and C: has 2.1 GB free. Free up some space and try again.'
    )
  })

  it('carries the subject and the advice it is given', () => {
    expect(shortfallMessage({ ...base, requiredBytes: 4 * GB, freeBytes: 1 * GB, subject: 'llama3.1:8b', advice: 'Use a bigger drive.' })).toBe(
      'llama3.1:8b needs about 4.0 GB and C: has 1.0 GB free. Use a bigger drive.'
    )
  })

  it('explains the spare room when the model would fit but leave the disk full', () => {
    expect(shortfallMessage({ ...base, requiredBytes: 4.9 * GB, freeBytes: 5.1 * GB })).toBe(
      'This model needs about 4.9 GB and C: has 5.1 GB free, but Cubex keeps 512 MB spare so the disk does not fill up. Free up some space and try again.'
    )
  })
})

describe('nearestExistingDir', () => {
  let dir = ''
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('walks up to the first folder that exists', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cubex-space-'))
    await mkdir(join(dir, 'a'))
    expect(await nearestExistingDir(join(dir, 'a', 'b', 'c'))).toBe(join(dir, 'a'))
    expect(await nearestExistingDir(dir)).toBe(dir)
  })
})

describe('checkFreeSpace', () => {
  const dir = tmpdir()
  const withFree = (free: number) => async (): Promise<number> => free

  it('passes when the model and the spare room fit', async () => {
    expect(await checkFreeSpace({ dir, requiredBytes: 4.9 * GB, freeBytes: withFree(20 * GB) })).toEqual({ ok: true })
  })

  it('refuses a model the disk cannot hold, with the sizes in the message', async () => {
    const result = await checkFreeSpace({ dir, requiredBytes: 4.9 * GB, freeBytes: withFree(2.1 * GB), subject: 'qwen3:8b' })
    expect(result).toMatchObject({ ok: false, freeBytes: 2.1 * GB, requiredBytes: 4.9 * GB })
    const message = result.ok ? '' : result.message
    expect(message).toContain('qwen3:8b needs about 4.9 GB and ')
    expect(message).toContain('has 2.1 GB free')
  })

  it('refuses a model that would fit but leave less than the spare room', async () => {
    const result = await checkFreeSpace({ dir, requiredBytes: 4.9 * GB, freeBytes: withFree(5.1 * GB) })
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.message).toContain('Cubex keeps 512 MB spare')
  })

  it('honours a different reserve', async () => {
    expect(await checkFreeSpace({ dir, requiredBytes: 5 * GB, reserveBytes: 0, freeBytes: withFree(5 * GB) })).toEqual({ ok: true })
  })

  it('never refuses because the disk could not be measured', async () => {
    expect(await checkFreeSpace({ dir, requiredBytes: 500 * GB, freeBytes: withFree(Number.POSITIVE_INFINITY) })).toEqual({ ok: true })
  })

  it('measures the nearest folder that exists, since the models folder may not yet', async () => {
    const asked: string[] = []
    await checkFreeSpace({
      dir: join(tmpdir(), 'cubex-not-created-yet', 'models'),
      requiredBytes: GB,
      freeBytes: async (measured) => {
        asked.push(measured)
        return 100 * GB
      }
    })
    expect(asked).toEqual([tmpdir()])
  })
})
