import { describe, expect, it } from 'vitest'
import { iconFor, isMarkdownPath, isSvgPath, languageName } from './fileKinds'

describe('file kinds', () => {
  it('names languages by extension and by well-known file name', () => {
    expect(languageName('src/app.tsx')).toBe('TypeScript React')
    expect(languageName('README.md')).toBe('Markdown')
    expect(languageName('Dockerfile')).toBe('Dockerfile')
    expect(languageName('data/events.NDJSON')).toBe('JSON lines')
    expect(languageName('notes')).toBe('Plain text')
    expect(languageName('weird.zzz')).toBe('Plain text')
  })

  it('picks an icon per family and a plain one for the rest', () => {
    expect(iconFor('a.ts')).toBe(iconFor('b.py'))
    expect(iconFor('a.png')).not.toBe(iconFor('a.ts'))
    expect(iconFor('package.json')).not.toBe(iconFor('a.ts'))
    expect(iconFor('mystery.bin')).toBe(iconFor('other.thing'))
    expect(iconFor('.gitignore')).toBe(iconFor('config.yml'))
  })

  it('knows which files have a rendered form', () => {
    expect(isMarkdownPath('docs/GUIDE.md')).toBe(true)
    expect(isMarkdownPath('a.mdx')).toBe(true)
    expect(isMarkdownPath('a.txt')).toBe(false)
    expect(isSvgPath('logo.SVG')).toBe(true)
    expect(isSvgPath('logo.png')).toBe(false)
  })
})
