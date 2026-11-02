import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveWorkerPath } from './workerPath'

/** A file system that holds exactly these paths. */
const holding = (...paths: string[]) => (path: string): boolean => paths.includes(path)

describe('resolveWorkerPath', () => {

  it('finds the worker inside app.asar when the app is packaged', () => {
    const bundle = join('C:', 'Program Files', 'Cubex', 'resources', 'app.asar', 'out', 'main')
    expect(resolveWorkerPath(bundle, holding(join(bundle, 'tsWorker.js')))).toBe(join(bundle, 'tsWorker.js'))
  })

  it('falls back to the other module extensions, in order', () => {
    const bundle = join('app', 'out', 'main')
    expect(resolveWorkerPath(bundle, holding(join(bundle, 'tsWorker.cjs'), join(bundle, 'tsWorker.mjs')))).toBe(join(bundle, 'tsWorker.mjs'))
    expect(resolveWorkerPath(bundle, holding(join(bundle, 'tsWorker.cjs')))).toBe(join(bundle, 'tsWorker.cjs'))
  })
})
