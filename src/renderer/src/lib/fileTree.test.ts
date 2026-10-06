import { describe, expect, it } from 'vitest'
import type { DirEntry } from '../../../shared/ipc'
import { flattenTree, splitMatch, type Listing } from './fileTree'

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

  it('says so when a folder is empty, and how many entries were left out', () => {
    expect(flattenTree({ '': ready([]) }, new Set())).toEqual([{ kind: 'note', path: '\0empty', depth: 0, text: 'This folder is empty.', tone: 'quiet' }])
    const rows = flattenTree({ '': ready([dir('empty')]), empty: ready([]) }, new Set(['empty']))
    expect(rows[1]).toMatchObject({ kind: 'note', text: 'Empty folder' })
    const cut = flattenTree({ '': ready([file('a.txt')], 1250) }, new Set())
    expect(cut[1]).toMatchObject({ kind: 'note', text: '1,250 more not shown. Search to find them.' })
  })

  it('marks hidden and ignored entries, and gives every row a distinct key', () => {
    const rows = flattenTree({ '': ready([dir('.git', true), dir('src'), file('a.txt')]), '.git': ready([]), src: ready([]) }, new Set(['.git', 'src']))
    expect(rows.filter((row) => row.kind !== 'note' && row.hidden).map((row) => row.path)).toEqual(['.git'])
    expect(new Set(rows.map((row) => row.path)).size).toBe(rows.length)
  })

  it('does not list the children of a folder that is not open', () => {
    const rows = flattenTree({ '': ready([dir('src')]), src: ready([file('src/a.ts')]) }, new Set())
    expect(rows).toHaveLength(1)
  })
})

describe('splitMatch', () => {
  it('splits text around the first match, ignoring case', () => {
    expect(splitMatch('Client.test.ts', 'client')).toEqual(['', 'Client', '.test.ts'])
    expect(splitMatch('src/upload/client.ts', 'LOAD')).toEqual(['src/up', 'load', '/client.ts'])
    expect(splitMatch('abcabc', 'bc')).toEqual(['a', 'bc', 'abc'])
  })

  it('leaves the text whole when nothing matches or nothing was typed', () => {
    expect(splitMatch('client.ts', 'zzz')).toEqual(['client.ts', '', ''])
    expect(splitMatch('client.ts', '')).toEqual(['client.ts', '', ''])
    expect(splitMatch('client.ts', '   ')).toEqual(['client.ts', '', ''])
  })
})
