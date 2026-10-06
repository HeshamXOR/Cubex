import { describe, expect, it } from 'vitest'
import { ancestorNodeModules, isWithinRoot, pathKey, relativeToRoot, sourceKind, tsPath } from './paths'

describe('pathKey', () => {
  it('ignores drive-letter case, slash style and case on Windows', () => {
    const a = pathKey('C:\\Proj\\Src\\a.ts', true)
    expect(pathKey('c:/proj/src/A.ts', true)).toBe(a)
    expect(pathKey('c:\\Proj/Src\\a.ts', true)).toBe(a)
  })

  it('resolves dot segments and drops a trailing separator', () => {
    expect(pathKey('C:\\proj\\src\\..\\lib\\', true)).toBe('c:/proj/lib')
    expect(pathKey('C:\\', true)).toBe('c:/')
  })

  it('stays case-sensitive on posix', () => {
    expect(pathKey('/proj/Src/a.ts', false)).not.toBe(pathKey('/proj/src/a.ts', false))
  })
})

describe('isWithinRoot', () => {
  it('accepts the root and anything below it, with spaces and mixed case', () => {
    expect(isWithinRoot('C:\\a b', 'C:\\a b', true)).toBe(true)
    expect(isWithinRoot('C:\\a b', 'c:\\A B\\c.ts', true)).toBe(true)
    expect(isWithinRoot('c:/a b', 'C:\\a b\\sub\\c.ts', true)).toBe(true)
  })

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

  it('treats a drive root as containing the whole drive', () => {
    expect(isWithinRoot('C:\\', 'C:\\x\\y.ts', true)).toBe(true)
    expect(isWithinRoot('/', '/x/y.ts', false)).toBe(true)
  })
})

describe('relativeToRoot', () => {
  it('returns forward slashes and keeps the original case of the file', () => {
    expect(relativeToRoot('C:\\proj', 'c:\\PROJ\\Src\\Deep\\A.ts', true)).toBe('Src/Deep/A.ts')
    expect(relativeToRoot('C:\\a b', 'C:\\a b\\c d\\e.ts', true)).toBe('c d/e.ts')
  })

  it('is empty for the root itself and undefined outside it', () => {
    expect(relativeToRoot('C:\\proj', 'C:\\proj', true)).toBe('')
    expect(relativeToRoot('C:\\proj', 'C:\\other\\a.ts', true)).toBeUndefined()
    expect(relativeToRoot('C:\\proj', 'D:\\proj\\a.ts', true)).toBeUndefined()
    expect(relativeToRoot('C:\\proj', 'C:\\proj\\..\\a.ts', true)).toBeUndefined()
  })

  it('works on posix', () => {
    expect(relativeToRoot('/work/proj', '/work/proj/src/a.ts', false)).toBe('src/a.ts')
  })
})

describe('tsPath', () => {
  it('hands the compiler forward slashes', () => {
    expect(tsPath('C:\\a b\\c.ts', true)).toBe('C:/a b/c.ts')
  })
})

describe('ancestorNodeModules', () => {
  it('lists node_modules of the root and every parent, nearest first', () => {
    expect(ancestorNodeModules('C:\\mono\\packages\\app', true)).toEqual([
      'C:\\mono\\packages\\app\\node_modules', 'C:\\mono\\packages\\node_modules', 'C:\\mono\\node_modules', 'C:\\node_modules'
    ])
    expect(ancestorNodeModules('/a/b', false)).toEqual(['/a/b/node_modules', '/a/node_modules', '/node_modules'])
  })
})

describe('sourceKind', () => {
  it('classifies the extensions the checker handles', () => {
    for (const name of ['a.ts', 'a.tsx', 'a.mts', 'a.cts', 'a.d.ts', 'A.TS']) expect(sourceKind(name)).toBe('ts')
    for (const name of ['a.js', 'a.jsx', 'a.mjs', 'a.cjs']) expect(sourceKind(name)).toBe('js')
    for (const name of ['a.json', 'a.css', 'a.py', 'a', 'ts', 'a.ts.map', 'a.tsx.bak']) expect(sourceKind(name)).toBeUndefined()
  })
})
