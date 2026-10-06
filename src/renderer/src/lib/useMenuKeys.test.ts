import { describe, expect, it } from 'vitest'
import { nextItem } from './useMenuKeys'

describe('moving between menu entries with the keyboard', () => {
  it('goes down and up one entry at a time and wraps at the ends', () => {
    expect(nextItem('ArrowDown', 0, 3)).toBe(1)
    expect(nextItem('ArrowDown', 2, 3)).toBe(0)
    expect(nextItem('ArrowUp', 1, 3)).toBe(0)
    expect(nextItem('ArrowUp', 0, 3)).toBe(2)
  })

  it('jumps to the first and last entry', () => {
    expect(nextItem('Home', 2, 4)).toBe(0)
    expect(nextItem('End', 0, 4)).toBe(3)
  })

  it('enters the list from the menu itself: down to the first entry, up to the last', () => {
    expect(nextItem('ArrowDown', -1, 3)).toBe(0)
    expect(nextItem('ArrowUp', -1, 3)).toBe(2)
  })

  it('leaves every other key alone, and an empty menu too', () => {
    expect(nextItem('a', 0, 3)).toBeUndefined()
    expect(nextItem('Enter', 0, 3)).toBeUndefined()
    expect(nextItem('ArrowLeft', 0, 3)).toBeUndefined()
    expect(nextItem('ArrowDown', -1, 0)).toBeUndefined()
  })
})
