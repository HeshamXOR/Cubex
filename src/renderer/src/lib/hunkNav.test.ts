import { describe, expect, it } from 'vitest'
import { nextHunkIndex } from './hunkNav'

describe('nextHunkIndex', () => {
  it('steps one change at a time', () => {
    expect(nextHunkIndex(2, 5, 1)).toBe(3)
    expect(nextHunkIndex(2, 5, -1)).toBe(1)
  })

  it('stops at the first and the last instead of wrapping', () => {
    expect(nextHunkIndex(4, 5, 1)).toBe(4)
    expect(nextHunkIndex(0, 5, -1)).toBe(0)
    expect(nextHunkIndex(0, 1, 1)).toBe(0)
  })

  it('starts from the first change going on and the last going back when focus is on none of them', () => {
    expect(nextHunkIndex(-1, 5, 1)).toBe(0)
    expect(nextHunkIndex(-1, 5, -1)).toBe(4)
  })

  it('has nowhere to go when there are no changes', () => {
    expect(nextHunkIndex(-1, 0, 1)).toBe(-1)
    expect(nextHunkIndex(0, 0, -1)).toBe(-1)
  })
})
