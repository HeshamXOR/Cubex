import { describe, expect, it } from 'vitest'
import { changedRange, numberHunkLines } from './hunkLines'

const hunk = (lines: string[], oldStart: number, oldLines: number, newStart: number, newLines: number) => ({ lines, oldStart, oldLines, newStart, newLines })

describe('numberHunkLines', () => {
  it('numbers each side on its own, so an added line has no old number and a removed line no new one', () => {
    const rows = numberHunkLines(hunk([' a', '-b', '+B', '+C', ' d'], 10, 3, 10, 4))
    expect(rows).toEqual([
      { tag: ' ', text: 'a', oldNo: 10, newNo: 10 },
      { tag: '-', text: 'b', oldNo: 11 },
      { tag: '+', text: 'B', newNo: 11 },
      { tag: '+', text: 'C', newNo: 12 },
      { tag: ' ', text: 'd', oldNo: 12, newNo: 13 }
    ])
  })

  it('starts one after the gap on a side that has no lines, as git writes it', () => {
    expect(numberHunkLines(hunk(['+x', '+y'], 4, 0, 5, 2))).toEqual([
      { tag: '+', text: 'x', newNo: 5 },
      { tag: '+', text: 'y', newNo: 6 }
    ])
    expect(numberHunkLines(hunk(['-x'], 7, 1, 6, 0))).toEqual([{ tag: '-', text: 'x', oldNo: 7 }])
    expect(numberHunkLines(hunk(['+only'], 0, 0, 1, 1))).toEqual([{ tag: '+', text: 'only', newNo: 1 }])
  })

  it('keeps an untagged line whole instead of dropping its first character', () => {
    expect(numberHunkLines(hunk(['plain'], 1, 1, 1, 1))).toEqual([{ tag: ' ', text: 'plain', oldNo: 1, newNo: 1 }])
  })
})

describe('changedRange', () => {
  it('spans the first to the last changed line on the new side', () => {
    expect(changedRange(hunk([' a', ' b', '-c', '+C', '+D', ' e'], 1, 4, 1, 5))).toEqual({ start: 3, end: 4 })
  })

  it('reports the line after the gap for a pure deletion', () => {
    expect(changedRange(hunk([' a', '-b', ' c'], 1, 3, 1, 2))).toEqual({ start: 2, end: 2 })
  })
})
