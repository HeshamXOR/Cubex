import { describe, expect, it } from 'vitest'
import type { DirEntry } from '../../../shared/ipc'
import { flattenTree, type Listing } from './fileTree'

const dir = (path: string, hidden = false): DirEntry => ({ name: path.split('/').pop()!, path, isDirectory: true, ...(hidden ? { hidden: true } : {}) })
const file = (path: string): DirEntry => ({ name: path.split('/').pop()!, path, isDirectory: false })
const ready = (entries: DirEntry[], omitted = 0): Listing => ({ status: 'ready', entries, omitted })

describe('flattenTree', () => {
  it('lists the root with folders as given', () => {
    const rows = flattenTree({ '': ready([dir('src'), file('README.md')]) }, new Set())
    expect(rows.map((row) => [row.kind, row.path, row.depth])).toEqual([['dir', 'src', 0], ['file', 'README.md', 0]])
  })

  it('puts an open folder\'s entries right under it, indented', () => {
    const listings = { '': ready([dir('src'), file('README.md')]), src: ready([dir('src/upload'), file('src/index.ts')]), 'src/upload': ready([file('src/upload/a.ts')]) }
    const rows = flattenTree(listings, new Set(['src', 'src/upload']))
    expect(rows.map((row) => [row.path, row.depth, row.kind === 'dir' ? row.open : undefined])).toEqual([
      ['src', 0, true], ['src/upload', 1, true], ['src/upload/a.ts', 2, undefined], ['src/index.ts', 1, undefined], ['README.md', 0, undefined]
    ])
  })

  it('shows a note while an open folder loads, and where it failed', () => {
    const loading = flattenTree({ '': ready([dir('src')]), src: { status: 'loading', entries: [], omitted: 0 } }, new Set(['src']))
    expect(loading[1]).toMatchObject({ kind: 'note', depth: 1, text: 'Loading', tone: 'quiet' })
    const missing = flattenTree({ '': ready([dir('src')]) }, new Set(['src']))
    expect(missing[1]).toMatchObject({ kind: 'note', text: 'Loading' })
    const failed = flattenTree({ '': ready([dir('src')]), src: { status: 'error', entries: [], omitted: 0, error: 'src was not found in the workspace.' } }, new Set(['src']))
    expect(failed[1]).toMatchObject({ kind: 'note', tone: 'error', text: 'src was not found in the workspace.' })
  })

})
