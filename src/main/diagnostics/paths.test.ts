import { describe, expect, it } from 'vitest'
import { isWithinRoot, pathKey } from './paths'

describe('pathKey', () => {
  it('ignores drive-letter case, slash style and case on Windows', () => {
    const a = pathKey('C:\\Proj\\Src\\a.ts', true)
    expect(pathKey('c:/proj/src/A.ts', true)).toBe(a)
    expect(pathKey('c:\\Proj/Src\\a.ts', true)).toBe(a)
  })
})

describe('isWithinRoot', () => {

  it('rejects siblings that merely share a prefix and dot-dot escapes', () => {
    expect(isWithinRoot('C:\\proj', 'C:\\proj2\\a.ts', true)).toBe(false)
    expect(isWithinRoot('C:\\proj', 'C:\\proj\\..\\other\\a.ts', true)).toBe(false)
    expect(isWithinRoot('C:\\proj', 'D:\\proj\\a.ts', true)).toBe(false)
  })

  it('handles UNC shares', () => {
    expect(isWithinRoot('\\\\srv\\share\\proj', '\\\\SRV\\share\\proj\\src\\a.ts', true)).toBe(true)
    expect(isWithinRoot('\\\\srv\\share\\proj', '\\\\srv\\share\\proj2\\a.ts', true)).toBe(false)
    expect(isWithinRoot('\\\\srv\\share\\proj', '\\\\srv\\other\\proj\\a.ts', true)).toBe(false)
  })
})
