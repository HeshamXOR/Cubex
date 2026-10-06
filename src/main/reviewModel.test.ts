import { describe, expect, it } from 'vitest'
import type { ReviewHunk } from '@shared/ipc'
import { buildReviewFile, changedRange, reverseHunk, reverseHunks } from './reviewModel'

/** Deterministic PRNG so a failing seed can be replayed. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Sample { before: string; after: string; eol: string; bom: string }

/** A baseline and an edited copy of it: random inserts, deletes and replacements, EOL, BOM and final newline. */
function sample(seed: number, unique = true): Sample {
  const r = rng(seed)
  const int = (n: number): number => Math.floor(r() * n)
  const eol = r() < 0.4 ? '\r\n' : '\n'
  const bom = r() < 0.3 ? '﻿' : ''
  const filler = ['', '}', '  return x']
  const base = Array.from({ length: 5 + int(60) }, (_, i) => (unique || r() < 0.85 ? `line ${i} of the file` : filler[int(3)]!))
  const lines = [...base]
  const edits = 1 + int(8)
  for (let e = 0; e < edits; e++) {
    const kind = int(3)
    const at = int(lines.length + 1)
    const size = 1 + int(3)
    const fresh = Array.from({ length: size }, (_, k) => `new ${seed} ${e} ${k}`)
    if (kind === 0) lines.splice(at, 0, ...fresh)
    else if (kind === 1) lines.splice(at, size)
    else lines.splice(at, size, ...fresh)
  }
  const join = (list: string[], newline: boolean): string => bom + list.join(eol) + (newline && list.length ? eol : '')
  return { before: join(base, r() < 0.7), after: join(lines, r() < 0.7), eol, bom }
}

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1)

describe('buildReviewFile', () => {
  it('builds one hunk with context, counts and a git-style header', () => {
    const file = buildReviewFile('a.txt', 'a\nb\nc\n', 'a\nB\nc\n')
    expect(file).toMatchObject({ path: 'a.txt', status: 'modified', added: 1, removed: 1, headHash: null })
    expect(file.hunks).toHaveLength(1)
    expect(file.hunks[0]).toMatchObject({
      header: '@@ -1,3 +1,3 @@', oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, state: 'pending',
      lines: [' a', '-b', '+B', ' c']
    })
    expect(file.hunks[0]!.id).toMatch(/^[a-f0-9]{40}$/)
  })

  it('numbers an insertion at the top and a deletion with git semantics', () => {
    expect(buildReviewFile('a', 'a\n', 'x\na\n').hunks[0]).toMatchObject({ header: '@@ -1,1 +1,2 @@', lines: ['+x', ' a'] })
    const added = buildReviewFile('a', null, 'x\ny\n')
    expect(added).toMatchObject({ status: 'added', added: 2, removed: 0 })
    expect(added.hunks[0]).toMatchObject({ header: '@@ -0,0 +1,2 @@', lines: ['+x', '+y'] })
    const deleted = buildReviewFile('a', 'x\ny\n', null)
    expect(deleted).toMatchObject({ status: 'deleted', added: 0, removed: 2 })
    expect(deleted.hunks[0]).toMatchObject({ header: '@@ -1,2 +0,0 @@', lines: ['-x', '-y'] })
  })

  it('does not count the shared final newline as a line, but does count a toggled one', () => {
    expect(buildReviewFile('a', '', 'x\n')).toMatchObject({ added: 1, removed: 0 })
    expect(buildReviewFile('a', 'x\n', '')).toMatchObject({ added: 0, removed: 1 })
    expect(buildReviewFile('a', 'a\n', 'a\n\n').hunks[0]!.lines).toEqual([' a', '+'])
    const toggled = buildReviewFile('a', 'a\nb\n', 'a\nb')
    expect(toggled.hunks).toHaveLength(1)
    expect(toggled.hunks[0]!.lines).toEqual([' a', ' b', '-'])
  })

  it('merges changes up to six lines apart and splits them beyond that', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `l${i}`)
    const edit = (...at: number[]): string => lines.map((line, i) => (at.includes(i) ? `${line}!` : line)).join('\n')
    expect(buildReviewFile('f', lines.join('\n'), edit(10, 17)).hunks).toHaveLength(1)
    expect(buildReviewFile('f', lines.join('\n'), edit(10, 18)).hunks).toHaveLength(2)
  })

  it('treats BOM and line ending changes alone as a format change with no hunks', () => {
    const file = buildReviewFile('a', 'a\r\nb\r\n', 'a\nb\n')
    expect(file.hunks).toEqual([])
    expect(file.formatChanged).toBe(true)
    expect(buildReviewFile('a', '﻿a\n', 'a\n').formatChanged).toBe(true)
    expect(buildReviewFile('a', 'a\n', 'a\n').formatChanged).toBeUndefined()
  })

  it('keeps ids stable under unrelated insertions above and unique for repeated bodies', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`)
    const before = lines.join('\n')
    const edited = lines.map((line, i) => (i === 30 ? 'changed' : line))
    const ids = buildReviewFile('f.ts', before, edited.join('\n')).hunks.map((h) => h.id)
    const shifted = ['top 1', 'top 2', 'top 3', ...edited].join('\n')
    const after = buildReviewFile('f.ts', before, shifted).hunks
    expect(after.map((h) => h.id)).toContain(ids[0])
    expect(buildReviewFile('other.ts', before, edited.join('\n')).hunks[0]!.id).not.toBe(ids[0])
    // Two identical blocks in one file still get distinct ids.
    const block = ['x', 'y', 'z', 'w', 'v', 'u', 'x', 'y']
    const repeated = [...block, ...Array.from({ length: 12 }, (_, i) => `gap ${i}`), ...block]
    const twice = buildReviewFile('r', repeated.join('\n'), repeated.map((l) => (l === 'z' ? 'Z' : l)).join('\n')).hunks
    expect(twice).toHaveLength(2)
    expect(new Set(twice.map((h) => h.id)).size).toBe(2)
  })

  it('is file-level only for binary, oversize and enormous diffs, and caps the hunk count', () => {
    expect(buildReviewFile('a.bin', 'a', 'b', { binary: true })).toMatchObject({ binary: true, hunks: [], added: 0, removed: 0 })
    expect(buildReviewFile('a', 'a\0', 'b')).toMatchObject({ binary: true, hunks: [] })
    expect(buildReviewFile('a', 'x'.repeat(100), 'y', { maxBytes: 50 })).toMatchObject({ oversize: true, hunks: [] })
    // A change every 8th line leaves 7 equal lines between changes, so each is its own hunk: 238 of them, 200 returned.
    const many = (mark: string): string => Array.from({ length: 1900 }, (_, i) => (i % 8 === 0 ? `${mark}${i}` : `l${i}`)).join('\n')
    const capped = buildReviewFile('big', many('a'), many('b'))
    expect(capped.hunks).toHaveLength(200)
    expect(capped.hunksOmitted).toBe(38)
    expect(capped.added).toBe(238)
    expect(capped.removed).toBe(238)
    const huge = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n')
    const other = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n')
    expect(buildReviewFile('huge', huge, other)).toMatchObject({ oversize: true, hunks: [] })
  })

  it('carries the file facts the store supplies', () => {
    const file = buildReviewFile('a', 'a', 'b', { headHash: 'f'.repeat(64), externallyModified: true, updatedAt: 7 })
    expect(file).toMatchObject({ headHash: 'f'.repeat(64), externallyModified: true, updatedAt: 7 })
  })
})

describe('changedRange', () => {
  it('spans the changed lines on the new side, or the line after a pure deletion', () => {
    const hunk = buildReviewFile('f', 'a\nb\nc\nd\ne\n', 'a\nb\nX\nY\nd\ne\n').hunks[0]!
    expect(changedRange(hunk)).toEqual({ start: 3, end: 4 })
    const removed = buildReviewFile('f', 'a\nb\nc\nd\ne\n', 'a\nb\nd\ne\n').hunks[0]!
    expect(changedRange(removed)).toEqual({ start: 3, end: 3 })
  })
})

describe('reverseHunk', () => {
  it('restores the old lines in place', () => {
    const hunk = buildReviewFile('a', 'a\nb\nc\n', 'a\nB\nc\n').hunks[0]!
    expect(reverseHunk('a\nB\nc\n', hunk, { fuzz: 0 })).toMatchObject({ ok: true, text: 'a\nb\nc\n', fuzz: 0, offset: 0 })
  })

  it('keeps CRLF, a BOM and untouched mixed endings byte for byte', () => {
    const before = '﻿one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n'
    const after = '﻿one\r\ntwo\r\nTHREE\r\nEXTRA\r\nfour\r\nfive\r\n'
    const hunk = buildReviewFile('a', before, after).hunks[0]!
    const result = reverseHunk(after, hunk, { fuzz: 0 })
    expect(result).toMatchObject({ ok: true })
    expect(result.ok && result.text).toBe(before)
    // A lone LF line elsewhere keeps its ending when another region is reverted.
    const mixed = `${after}\nlast line with a bare LF\n`
    const reverted = reverseHunk(mixed, hunk, { fuzz: 0 })
    expect(reverted.ok && reverted.text).toBe(`${before}\nlast line with a bare LF\n`)
  })

  it('reverses added lines at the end of a file without a final newline', () => {
    const before = 'a\nb'
    const after = 'a\nb\nc'
    const hunk = buildReviewFile('a', before, after).hunks[0]!
    const result = reverseHunk(after, hunk, { fuzz: 0 })
    expect(result.ok && result.text).toBe(before)
  })

  it('finds a hunk that moved (lines inserted above) and reports the offset', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`)
    const before = lines.join('\n')
    const after = lines.map((line, i) => (i === 30 ? 'changed' : line)).join('\n')
    const hunk = buildReviewFile('f', before, after).hunks[0]!
    const current = `user 1\nuser 2\nuser 3\n${after}`
    const result = reverseHunk(current, hunk, { fuzz: 0 })
    expect(result).toMatchObject({ ok: true, offset: 3, fuzz: 0 })
    expect(result.ok && result.text).toBe(`user 1\nuser 2\nuser 3\n${before}`)
  })

  it('keeps a user edit made elsewhere in the file', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`)
    const before = lines.join('\n')
    const after = lines.map((line, i) => (i === 30 ? 'changed' : line)).join('\n')
    const hunk = buildReviewFile('f', before, after).hunks[0]!
    const current = after.replace('line 5\n', 'mine 5\n')
    const result = reverseHunk(current, hunk, { fuzz: 0 })
    expect(result.ok && result.text).toBe(before.replace('line 5\n', 'mine 5\n'))
  })

  it('reports drift when the changed lines were edited, removed or the file was replaced', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`)
    const before = lines.join('\n')
    const after = lines.map((line, i) => (i === 30 ? 'changed' : line)).join('\n')
    const hunk = buildReviewFile('f', before, after).hunks[0]!
    expect(reverseHunk(after.replace('changed', 'changed again'), hunk, { fuzz: 3 })).toEqual({ ok: false, reason: 'drift' })
    expect(reverseHunk(before, hunk, { fuzz: 3 })).toEqual({ ok: false, reason: 'drift' })
    expect(reverseHunk('something else entirely\nwith other lines\n', hunk, { fuzz: 3 })).toEqual({ ok: false, reason: 'drift' })
    expect(reverseHunk('', hunk, { fuzz: 3 })).toEqual({ ok: false, reason: 'drift' })
  })

  it('needs fuzz when only the surrounding context changed, and never touches that context', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`)
    const before = lines.join('\n')
    const after = lines.map((line, i) => (i === 30 ? 'changed' : line)).join('\n')
    const hunk = buildReviewFile('f', before, after).hunks[0]!
    const current = after.replace('line 28', 'my line 28')
    expect(reverseHunk(current, hunk, { fuzz: 0 })).toEqual({ ok: false, reason: 'context_mismatch' })
    const fuzzy = reverseHunk(current, hunk, { fuzz: 3 })
    expect(fuzzy).toMatchObject({ ok: true })
    expect(fuzzy.ok && fuzzy.fuzz).toBeGreaterThan(0)
    expect(fuzzy.ok && fuzzy.text).toBe(before.replace('line 28', 'my line 28'))
  })

  it('refuses an ambiguous match instead of guessing', () => {
    const hunk: ReviewHunk = { id: 'x', header: '@@ -50,1 +50,1 @@', oldStart: 50, oldLines: 1, newStart: 50, newLines: 1, lines: ['-old', '+dup'], state: 'pending' }
    const text = 'dup\nspacer\ndup\n'
    expect(reverseHunk(text, hunk, { fuzz: 0 })).toEqual({ ok: false, reason: 'context_mismatch' })
  })

  it('restores a pure deletion between its context and removes a pure insertion', () => {
    const before = 'a\nb\nc\nd\ne\nf\ng\n'
    const deleted = 'a\nb\nc\ne\nf\ng\n'
    const hunk = buildReviewFile('f', before, deleted).hunks[0]!
    const result = reverseHunk(deleted, hunk, { fuzz: 0 })
    expect(result.ok && result.text).toBe(before)
    const emptied = buildReviewFile('g', 'x\n', '').hunks[0]!
    const restored = reverseHunk('', emptied, { fuzz: 0 })
    expect(restored.ok && restored.text).toBe('x\n')
    expect(reverseHunk('not empty\n', emptied, { fuzz: 3 })).toMatchObject({ ok: false })
  })
})

describe('review model properties', () => {
  it('the generator covers multi-hunk files, CRLF, a BOM, and a toggled final newline', () => {
    const tally = { multi: 0, crlf: 0, bom: 0, toggled: 0, empty: 0 }
    for (const seed of SEEDS) {
      const { before, after, eol, bom } = sample(seed)
      const hunks = buildReviewFile('p.txt', before, after).hunks
      if (hunks.length >= 2) tally.multi++
      if (eol === '\r\n') tally.crlf++
      if (bom) tally.bom++
      if (before.endsWith('\n') !== after.endsWith('\n')) tally.toggled++
      if (!hunks.length) tally.empty++
    }
    expect(tally.multi).toBeGreaterThan(100)
    expect(tally.crlf).toBeGreaterThan(60)
    expect(tally.bom).toBeGreaterThan(40)
    expect(tally.toggled).toBeGreaterThan(40)
    expect(tally.empty).toBeLessThan(30)
  })
  it('reverting every hunk restores the baseline byte for byte (LF, CRLF, BOM, final newline)', () => {
    for (const seed of SEEDS) {
      const { before, after } = sample(seed, seed % 3 !== 0)
      const file = buildReviewFile('p.txt', before, after)
      const result = reverseHunks(after, file.hunks, { fuzz: 0 })
      expect({ seed, conflicts: result.conflicts }).toEqual({ seed, conflicts: [] })
      expect({ seed, text: result.text }).toEqual({ seed, text: before })
    }
  })

  it('restores the baseline when hunks are reverted one by one in any order', () => {
    for (const seed of SEEDS) {
      const { before, after } = sample(seed)
      const hunks = buildReviewFile('p.txt', before, after).hunks
      const r = rng(seed * 7919)
      const order = [...hunks].sort(() => r() - 0.5)
      let text = after
      for (const hunk of order) {
        const result = reverseHunk(text, hunk, { fuzz: 0 })
        expect({ seed, ok: result.ok }).toEqual({ seed, ok: true })
        if (result.ok) text = result.text
      }
      expect({ seed, text }).toEqual({ seed, text: before })
    }
  })

  it('reverting a subset then re-diffing yields exactly the remaining hunks', () => {
    for (const seed of SEEDS) {
      const { before, after } = sample(seed)
      const hunks = buildReviewFile('p.txt', before, after).hunks
      const r = rng(seed * 104729)
      const chosen = hunks.filter(() => r() < 0.5)
      const kept = hunks.filter((hunk) => !chosen.includes(hunk))
      const result = reverseHunks(after, chosen, { fuzz: 0 })
      expect({ seed, conflicts: result.conflicts }).toEqual({ seed, conflicts: [] })
      const remaining = buildReviewFile('p.txt', before, result.text).hunks
      expect({ seed, ids: remaining.map((h) => h.id) }).toEqual({ seed, ids: kept.map((h) => h.id) })
      expect({ seed, lines: remaining.map((h) => h.lines) }).toEqual({ seed, lines: kept.map((h) => h.lines) })
      expect({ seed, old: remaining.map((h) => h.oldStart) }).toEqual({ seed, old: kept.map((h) => h.oldStart) })
    }
  })

  it('keeps ids when unrelated lines are inserted far above', () => {
    let checked = 0
    for (const seed of SEEDS) {
      const { before, after, eol, bom } = sample(seed)
      const hunks = buildReviewFile('p.txt', before, after).hunks
      if (!hunks.length || hunks[0]!.oldStart < 12 || hunks[0]!.newStart < 12) continue
      const body = bom ? after.slice(1) : after
      const shifted = `${bom}top a${eol}top b${eol}top c${eol}${body}`
      const ids = buildReviewFile('p.txt', before, shifted).hunks.map((h) => h.id)
      for (const hunk of hunks) expect({ seed, has: ids.includes(hunk.id) }).toEqual({ seed, has: true })
      checked++
    }
    expect(checked).toBeGreaterThan(20)
  })

  it('never mixes up hunks of repetitive text: baseline is restored or a conflict is reported', () => {
    for (const seed of SEEDS) {
      const { before, after } = sample(seed, false)
      const file = buildReviewFile('p.txt', before, after)
      const result = reverseHunks(after, file.hunks, { fuzz: 0 })
      expect({ seed, conflicts: result.conflicts }).toEqual({ seed, conflicts: [] })
      expect({ seed, text: result.text }).toEqual({ seed, text: before })
    }
  })
})
