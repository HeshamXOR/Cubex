import { describe, expect, it } from 'vitest'
import { ancestorsOf, parsePathReference } from './pathLinks'

const path = (text: string): string | undefined => parsePathReference(text)?.path

describe('parsePathReference paths', () => {
  it('accepts relative paths, with either separator', () => {
    expect(parsePathReference('src/upload/client.ts')).toEqual({ path: 'src/upload/client.ts' })
    expect(parsePathReference('src\\upload\\client.ts')).toEqual({ path: 'src\\upload\\client.ts' })
    expect(parsePathReference('./src/app.tsx')).toEqual({ path: 'src/app.tsx' })
    expect(parsePathReference('README.md')).toEqual({ path: 'README.md' })
    expect(parsePathReference('  package.json  ')).toEqual({ path: 'package.json' })
  })

  it('accepts dot-files, double extensions and extensionless project files', () => {
    expect(path('.gitignore')).toBe('.gitignore')
    expect(path('.github/workflows/ci.yml')).toBe('.github/workflows/ci.yml')
    expect(path('types.d.ts')).toBe('types.d.ts')
    expect(path('Dockerfile')).toBe('Dockerfile')
    expect(path('LICENSE')).toBe('LICENSE')
  })

  it('accepts a Windows absolute path', () => {
    expect(parsePathReference('I:\\Cubex\\src\\main\\ipc.ts:12')).toEqual({ path: 'I:\\Cubex\\src\\main\\ipc.ts', line: 12 })
    expect(path('C:/work/app/main.py')).toBe('C:/work/app/main.py')
  })

  it('accepts a folder named inside a folder, with or without a slash', () => {
    expect(path('src/upload')).toBe('src/upload')
    expect(path('src/upload/')).toBe('src/upload')
    expect(path('packages\\core')).toBe('packages\\core')
  })

  it('leaves identifiers, words, numbers and flags alone', () => {
    for (const text of ['useStore', 'uploadChunk', 'foo', 'true', '42', '1.2.3', '3.14', '12:30', '--flag', '-v', '', '   ', '.', '..', '...', 'a b.ts', 'x.']) {
      expect(parsePathReference(text), text).toBeNull()
    }
  })

  it('leaves URLs, aliases, selectors and anything with wildcards alone', () => {
    for (const text of ['https://example.com/a.ts', 'mailto:me@example.com', '@shared/ipc', '@types/node', '#id', '*.ts', 'src/**/*.ts', 'a|b.ts', '"a.ts"', '`a.ts`', '<div>', 'a?b.ts']) {
      expect(parsePathReference(text), text).toBeNull()
    }
  })

  it('leaves stray colons alone', () => {
    expect(parsePathReference('a:b.ts')).toBeNull()
    expect(parsePathReference('C:\\a:b.ts')).toBeNull()
  })

  it('bounds the length', () => {
    expect(parsePathReference(`${'a/'.repeat(200)}b.ts`)).toBeNull()
    expect(parsePathReference('x'.repeat(400))).toBeNull()
  })
})

describe('parsePathReference positions', () => {
  it('reads a line and a column after a colon', () => {
    expect(parsePathReference('src/a.ts:42')).toEqual({ path: 'src/a.ts', line: 42 })
    expect(parsePathReference('src/a.ts:42:7')).toEqual({ path: 'src/a.ts', line: 42, column: 7 })
    expect(parsePathReference('src/a.ts:42-50')).toEqual({ path: 'src/a.ts', line: 42 })
  })

  it('reads GitHub-style anchors', () => {
    expect(parsePathReference('src/a.ts#L42')).toEqual({ path: 'src/a.ts', line: 42 })
    expect(parsePathReference('src/a.ts#L42-L50')).toEqual({ path: 'src/a.ts', line: 42 })
    expect(parsePathReference('src/a.ts#L42C7')).toEqual({ path: 'src/a.ts', line: 42, column: 7 })
  })

  it('reads the position TypeScript prints', () => {
    expect(parsePathReference('src/a.ts(42,7)')).toEqual({ path: 'src/a.ts', line: 42, column: 7 })
    expect(parsePathReference('src/a.ts(42)')).toEqual({ path: 'src/a.ts', line: 42 })
  })

  it('ignores a position that is not a line', () => {
    expect(parsePathReference('src/a.ts:0')).toEqual({ path: 'src/a.ts' })
    expect(parsePathReference('src/a.ts:99999999999')).toEqual({ path: 'src/a.ts' })
  })

  it('does not take a call for a path with a position', () => {
    expect(parsePathReference('fn(42)')).toBeNull()
    expect(parsePathReference('get(1,2)')).toBeNull()
  })
})

describe('ancestorsOf', () => {
  it('lists the folders above a path, outermost first', () => {
    expect(ancestorsOf('a/b/c.ts')).toEqual(['a', 'a/b'])
    expect(ancestorsOf('c.ts')).toEqual([])
    expect(ancestorsOf('src/upload')).toEqual(['src'])
    expect(ancestorsOf('')).toEqual([])
  })
})
