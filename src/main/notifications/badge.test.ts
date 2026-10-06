import { describe, expect, it } from 'vitest'
import { BADGE_SCALE, BADGE_SIZE, badgeLabel, renderBadge } from './badge'

const pixel = (bitmap: Buffer, x: number, y: number): { b: number; g: number; r: number; a: number } => {
  const at = (y * BADGE_SIZE + x) * 4
  return { b: bitmap[at]!, g: bitmap[at + 1]!, r: bitmap[at + 2]!, a: bitmap[at + 3]! }
}

describe('badgeLabel', () => {
  it('shows the number, and 9+ from ten up', () => {
    expect(badgeLabel(1)).toBe('1')
    expect(badgeLabel(9)).toBe('9')
    expect(badgeLabel(10)).toBe('9+')
    expect(badgeLabel(250)).toBe('9+')
    expect(badgeLabel(-3)).toBe('0')
    expect(badgeLabel(2.9)).toBe('2')
  })
})

describe('renderBadge', () => {
  it('draws a disc in a bitmap of the declared size', () => {
    const badge = renderBadge(3)
    expect(badge).toMatchObject({ width: BADGE_SIZE, height: BADGE_SIZE, scaleFactor: BADGE_SCALE })
    expect(badge.bitmap.length).toBe(BADGE_SIZE * BADGE_SIZE * 4)
  })

  it('leaves the corners clear and the rim solid', () => {
    const { bitmap } = renderBadge(3)
    expect(pixel(bitmap, 0, 0).a).toBe(0)
    expect(pixel(bitmap, BADGE_SIZE - 1, BADGE_SIZE - 1).a).toBe(0)
    expect(pixel(bitmap, 16, 2)).toEqual({ r: 230, g: 169, b: 64, a: 255 })
    expect(pixel(bitmap, 2, 16)).toEqual({ r: 230, g: 169, b: 64, a: 255 })
  })

  it('writes the number in dark ink on the disc', () => {
    const { bitmap } = renderBadge(1)
    const ink = { r: 36, g: 26, b: 2, a: 255 }
    let inked = 0
    for (let y = 0; y < BADGE_SIZE; y++) for (let x = 0; x < BADGE_SIZE; x++) {
      const p = pixel(bitmap, x, y)
      if (p.r === ink.r && p.g === ink.g && p.b === ink.b && p.a === 255) inked++
    }
    // A 1 is 10 lit cells of a 5 by 7 grid, each drawn 3 by 3 pixels.
    expect(inked).toBe(10 * 9)
  })

  it('draws different numbers differently and one picture for everything from ten', () => {
    expect(renderBadge(1).bitmap.equals(renderBadge(2).bitmap)).toBe(false)
    expect(renderBadge(10).bitmap.equals(renderBadge(99).bitmap)).toBe(true)
    expect(renderBadge(10).bitmap.equals(renderBadge(9).bitmap)).toBe(false)
  })

  it('keeps every digit inside the disc', () => {
    for (const count of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const { bitmap } = renderBadge(count)
      for (let y = 0; y < BADGE_SIZE; y++) for (let x = 0; x < BADGE_SIZE; x++) {
        const outside = Math.hypot(x - 15.5, y - 15.5) > 16.5
        if (outside) expect(pixel(bitmap, x, y).a, `${count} at ${x},${y}`).toBe(0)
      }
    }
  })
})
