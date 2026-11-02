import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkFreeSpace, nearestExistingDir } from './diskSpace'

const GB = 1024 ** 3

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

  it('never refuses because the disk could not be measured', async () => {
    expect(await checkFreeSpace({ dir, requiredBytes: 500 * GB, freeBytes: withFree(Number.POSITIVE_INFINITY) })).toEqual({ ok: true })
  })
})
