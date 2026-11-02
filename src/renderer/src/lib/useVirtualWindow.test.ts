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

  it('renders nothing for an empty list', () => {
    expect(visibleRange(0, 200, 20, 0, 5)).toEqual({ start: 0, end: 0 })
    expect(visibleRange(500, 200, 20, 0, 5)).toEqual({ start: 0, end: 0 })
  })

})
