import { describe, it, expect } from 'vitest'
import { parseDuckDuckGoHtml, createWebSearchTool } from './webSearchTool'

const SAMPLE = `
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=x">Example <b>Docs</b></a>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">The official <b>docs</b> for Example &amp; friends.</a>
</div>
<div class="result results_links">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffoo.dev%2Fguide&amp;rut=y">Foo Guide</a>
  <a class="result__snippet" href="#">A guide to Foo.</a>
</div>
`

describe('parseDuckDuckGoHtml', () => {
  it('extracts titles, unwrapped URLs, and snippets', () => {
    const hits = parseDuckDuckGoHtml(SAMPLE)
    expect(hits).toHaveLength(2)
    expect(hits[0]).toEqual({ title: 'Example Docs', url: 'https://example.com/docs', snippet: 'The official docs for Example & friends.' })
    expect(hits[1]!.url).toBe('https://foo.dev/guide')
  })

  it('respects the limit', () => {
    expect(parseDuckDuckGoHtml(SAMPLE, 1)).toHaveLength(1)
  })

  it('returns [] for empty/garbage html', () => {
    expect(parseDuckDuckGoHtml('<html>nothing</html>')).toEqual([])
  })

  it('tool is allow-permission', () => {
    expect(createWebSearchTool().defaultPermission).toBe('allow')
  })
})
