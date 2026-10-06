import { describe, expect, it } from 'vitest'
import { safeMarkdownUrl } from './markdownUrl'

describe('markdown URL policy', () => {
  it('drops every image that is not inline data, including protocol-relative UNC-style URLs', () => {
    for (const src of ['//evil.example/share/x.png', 'file://host/c$/x.png', '/C:/Users/me/secret.png', 'https://evil.example/x.png', String.raw`\\host\share\x.png`]) {
      expect(safeMarkdownUrl(src, 'src')).toBe('')
    }
    expect(safeMarkdownUrl('data:image/png;base64,AAAA', 'src')).toBe('data:image/png;base64,AAAA')
    expect(safeMarkdownUrl('data:image/svg+xml;base64,AAAA', 'src')).toBe('')
  })

  it('keeps only externally openable link schemes', () => {
    expect(safeMarkdownUrl('https://docs.example/a', 'href')).toBe('https://docs.example/a')
    expect(safeMarkdownUrl('mailto:a@b.c', 'href')).toBe('mailto:a@b.c')
    for (const href of ['javascript:alert(1)', 'file:///C:/x', '//evil.example', 'smb://host/x']) expect(safeMarkdownUrl(href, 'href')).toBe('')
  })
})
