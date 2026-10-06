import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspacePathStat } from '../../../shared/workspaceFile'
import { FOUND_TTL_MS, MISSING_TTL_MS, PathChecker } from './pathChecker'

const found = (path: string): WorkspacePathStat => ({ kind: 'file', path })
const MISSING: WorkspacePathStat = { kind: 'missing' }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
})
afterEach(() => vi.useRealTimers())

/** A stat that knows these paths and answers `missing` for the rest. */
function checker(known: string[] = ['src/a.ts', 'src/b.ts']) {
  const calls: Array<{ paths: string[]; conversationId: string | undefined }> = []
  const instance = new PathChecker({
    stat: async (paths, conversationId) => {
      calls.push({ paths, conversationId })
      return paths.map((path) => (known.includes(path) ? found(path) : MISSING))
    }
  })
  return { instance, calls }
}

describe('PathChecker', () => {
  it('asks once for everything seen in the same moment', async () => {
    const { instance, calls } = checker()
    const answers = Promise.all([instance.check('w', 'c1', 'src/a.ts'), instance.check('w', 'c1', 'src/b.ts'), instance.check('w', 'c1', 'nope.ts')])
    await vi.advanceTimersByTimeAsync(20)
    expect(await answers).toEqual([found('src/a.ts'), found('src/b.ts'), MISSING])
    expect(calls).toEqual([{ paths: ['src/a.ts', 'src/b.ts', 'nope.ts'], conversationId: 'c1' }])
  })

  it('asks once for a path however many places show it', async () => {
    const { instance, calls } = checker()
    const answers = Promise.all([instance.check('w', undefined, 'src/a.ts'), instance.check('w', undefined, 'src/a.ts'), instance.check('w', undefined, 'src/a.ts')])
    await vi.advanceTimersByTimeAsync(20)
    expect(await answers).toEqual([found('src/a.ts'), found('src/a.ts'), found('src/a.ts')])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.paths).toEqual(['src/a.ts'])
  })

  it('remembers an answer, and offers it without waiting', async () => {
    const { instance, calls } = checker()
    const first = instance.check('w', undefined, 'src/a.ts')
    await vi.advanceTimersByTimeAsync(20)
    await first
    expect(instance.peek('w', 'src/a.ts')).toEqual(found('src/a.ts'))
    expect(await instance.check('w', undefined, 'src/a.ts')).toEqual(found('src/a.ts'))
    expect(calls).toHaveLength(1)
  })

  it('has no opinion about a path it has not been asked about', () => {
    const { instance } = checker()
    expect(instance.peek('w', 'src/a.ts')).toBeUndefined()
  })

  it('rechecks a miss sooner than a hit', async () => {
    const { instance, calls } = checker()
    const first = Promise.all([instance.check('w', undefined, 'src/a.ts'), instance.check('w', undefined, 'new.ts')])
    await vi.advanceTimersByTimeAsync(20)
    await first
    expect(calls).toHaveLength(1)

    vi.setSystemTime(10_000 + MISSING_TTL_MS + 100)
    expect(instance.peek('w', 'src/a.ts')).toEqual(found('src/a.ts'))
    expect(instance.peek('w', 'new.ts')).toBeUndefined()

    vi.setSystemTime(10_000 + FOUND_TTL_MS + 100)
    expect(instance.peek('w', 'src/a.ts')).toBeUndefined()
  })

  it('keeps workspaces apart', async () => {
    const { instance, calls } = checker()
    const both = Promise.all([instance.check('w1', 'c1', 'src/a.ts'), instance.check('w2', 'c2', 'src/a.ts')])
    await vi.advanceTimersByTimeAsync(20)
    await both
    expect(calls.map((call) => call.conversationId).sort()).toEqual(['c1', 'c2'])
    expect(instance.peek('w1', 'src/a.ts')).toBeDefined()
    expect(instance.peek('w3', 'src/a.ts')).toBeUndefined()
  })

  it('splits a big batch into requests of 40', async () => {
    const { instance, calls } = checker()
    const paths = Array.from({ length: 95 }, (_, index) => `f${index}.ts`)
    const answers = Promise.all(paths.map((path) => instance.check('w', undefined, path)))
    await vi.advanceTimersByTimeAsync(20)
    expect((await answers).every((answer) => answer.kind === 'missing')).toBe(true)
    expect(calls.map((call) => call.paths.length)).toEqual([40, 40, 15])
  })

  it('treats a failed request as a miss and tries again shortly after', async () => {
    let fail = true
    const stat = vi.fn(async (paths: string[]) => {
      if (fail) throw new Error('window closing')
      return paths.map((path) => found(path))
    })
    const instance = new PathChecker({ stat })
    const first = instance.check('w', undefined, 'src/a.ts')
    await vi.advanceTimersByTimeAsync(20)
    expect(await first).toEqual(MISSING)

    fail = false
    vi.setSystemTime(10_000 + 2_500)
    const second = instance.check('w', undefined, 'src/a.ts')
    await vi.advanceTimersByTimeAsync(20)
    expect(await second).toEqual(found('src/a.ts'))
    expect(stat).toHaveBeenCalledTimes(2)
  })

  it('can forget everything it knows', async () => {
    const { instance } = checker()
    const first = instance.check('w', undefined, 'src/a.ts')
    await vi.advanceTimersByTimeAsync(20)
    await first
    instance.clear()
    expect(instance.peek('w', 'src/a.ts')).toBeUndefined()
  })
})
