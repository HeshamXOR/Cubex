import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findAppDir, resolveWorkerPath } from './workerPath'

/** A file system that holds exactly these paths. */
const holding = (...paths: string[]) => (path: string): boolean => paths.includes(path)

describe('resolveWorkerPath', () => {
  it('finds the worker beside the main bundle in development', () => {
    const bundle = join('repo', 'out', 'main')
    expect(resolveWorkerPath(bundle, holding(join(bundle, 'index.js'), join(bundle, 'tsWorker.js')))).toBe(join(bundle, 'tsWorker.js'))
  })

  it('finds the worker inside app.asar when the app is packaged', () => {
    const bundle = join('C:', 'Program Files', 'Cubex', 'resources', 'app.asar', 'out', 'main')
    expect(resolveWorkerPath(bundle, holding(join(bundle, 'tsWorker.js')))).toBe(join(bundle, 'tsWorker.js'))
  })

  it('falls back to the other module extensions, in order', () => {
    const bundle = join('app', 'out', 'main')
    expect(resolveWorkerPath(bundle, holding(join(bundle, 'tsWorker.cjs'), join(bundle, 'tsWorker.mjs')))).toBe(join(bundle, 'tsWorker.mjs'))
    expect(resolveWorkerPath(bundle, holding(join(bundle, 'tsWorker.cjs')))).toBe(join(bundle, 'tsWorker.cjs'))
  })

  it('answers undefined when nothing was built there, as from source', () => {
    expect(resolveWorkerPath(join('repo', 'src', 'main', 'diagnostics'), holding())).toBeUndefined()
  })

  it('looks only beside the bundle, never in a parent folder', () => {
    const bundle = join('repo', 'out', 'main')
    expect(resolveWorkerPath(bundle, holding(join('repo', 'out', 'tsWorker.js')))).toBeUndefined()
  })
})

describe('findAppDir', () => {
  it('walks up from the bundle to the folder with the app manifest', () => {
    const repo = join('work', 'cubex')
    expect(findAppDir(join(repo, 'out', 'main'), holding(join(repo, 'package.json')))).toBe(repo)
    const archive = join('C:', 'Cubex', 'resources', 'app.asar')
    expect(findAppDir(join(archive, 'out', 'main'), holding(join(archive, 'package.json')))).toBe(archive)
  })

  it('works from source too, one folder deeper than the bundle', () => {
    const repo = join('work', 'cubex')
    expect(findAppDir(join(repo, 'src', 'main', 'diagnostics'), holding(join(repo, 'package.json')))).toBe(repo)
  })

  it('answers the bundle folder itself when no manifest is above it', () => {
    const bundle = join('somewhere', 'out', 'main')
    expect(findAppDir(bundle, holding())).toBe(bundle)
  })
})
