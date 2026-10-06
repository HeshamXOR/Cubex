import { describe, expect, it } from 'vitest'
import { visibleRange } from './useVirtualWindow'

describe('visibleRange', () => {
  it('renders the rows in view plus a margin', () => {
    expect(visibleRange(0, 200, 20, 1000, 5)).toEqual({ start: 0, end: 15 })
    expect(visibleRange(2000, 200, 20, 1000, 5)).toEqual({ start: 95, end: 115 })
  })

  it('stops at both ends of the list', () => {
    expect(visibleRange(0, 200, 20, 3, 5)).toEqual({ start: 0, end: 3 })
    expect(visibleRange(19_800, 200, 20, 1000, 5)).toEqual({ start: 985, end: 1000 })
    expect(visibleRange(999_999, 200, 20, 1000, 5)).toEqual({ start: 995, end: 1000 })
  })

  it('renders something before the container has a height', () => {
    expect(visibleRange(0, 0, 20, 1000, 5)).toEqual({ start: 0, end: 35 })
  })

  it('renders nothing for an empty list', () => {
    expect(visibleRange(0, 200, 20, 0, 5)).toEqual({ start: 0, end: 0 })
    expect(visibleRange(500, 200, 20, 0, 5)).toEqual({ start: 0, end: 0 })
  })

  it('keeps a partly visible row', () => {
    expect(visibleRange(10, 200, 20, 1000, 0)).toEqual({ start: 0, end: 11 })
  })

  it('treats a negative scroll position as the top', () => {
    expect(visibleRange(-50, 100, 20, 100, 2)).toEqual({ start: 0, end: 7 })
  })

  it('stays small however long the list is', () => {
    const { start, end } = visibleRange(1_000_000, 900, 20, 50_000, 20)
    expect(end - start).toBeLessThan(100)
  })
})
