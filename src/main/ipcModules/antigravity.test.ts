import { describe, expect, it } from 'vitest'
import { parseOperationId } from './antigravity'

describe('the id of an installation or a sign-in that the window wants to stop', () => {
  it('is a string, which the installer or the sign-in checks against the one it has', () => {
    expect(parseOperationId('7d1f6a3e-0b9a-4c52-9d0e-5b7a1f3c2e44')).toBe('7d1f6a3e-0b9a-4c52-9d0e-5b7a1f3c2e44')
  })

  it.each([[undefined], [null], [''], [7], [{}], [['a']], ['x'.repeat(101)]])('is refused when it is %j', (value) => {
    expect(() => parseOperationId(value)).toThrow(/not an installation or sign-in id/)
  })

  it('may be as long as a hundred characters, and no longer', () => {
    expect(parseOperationId('x'.repeat(100))).toHaveLength(100)
  })
})
