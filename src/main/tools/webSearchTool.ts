import type { ExecutableTool, JSONValue, ToolResult } from '@core/types'

const TIMEOUT = 15_000
const MAX_RESULTS = 8

interface SearchHit {
  title: string
  url: string
  snippet: string
}

function decodeEntities(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** DuckDuckGo wraps result links in /l/?uddg=<encoded>; unwrap to the real URL. */
function unwrapUrl(href: string): string {
  const m = /[?&]uddg=([^&]+)/.exec(href)
  if (m) {
    try {
      return decodeURIComponent(m[1]!)
    } catch {
      /* fall through */
    }
  }
  if (href.startsWith('//')) return `https:${href}`
  return href
}

/** Parse the DuckDuckGo HTML results page into structured hits. Exported for tests. */
export function parseDuckDuckGoHtml(html: string, limit = MAX_RESULTS): SearchHit[] {
  const hits: SearchHit[] = []
  const anchorRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g
  const snippets: string[] = []
  let sm: RegExpExecArray | null
  while ((sm = snippetRe.exec(html))) snippets.push(decodeEntities(sm[1]!))
  let am: RegExpExecArray | null
  let i = 0
  while ((am = anchorRe.exec(html)) && hits.length < limit) {
    const url = unwrapUrl(am[1]!)
    const title = decodeEntities(am[2]!)
    if (title && /^https?:/.test(url)) hits.push({ title, url, snippet: snippets[i] ?? '' })
    i++
  }
  return hits
}

/**
 * `web_search` — a keyword web search via DuckDuckGo's HTML endpoint (no API key).
 * Best-effort scrape: returns titles, URLs, and snippets. Pair with web_fetch to
 * read a result. Read-only → no permission prompt.
 */
export function createWebSearchTool(): ExecutableTool {
  return {
    definition: {
      name: 'web_search',
      description:
        'Search the web (keyword query) and get back a ranked list of result titles, URLs, and snippets. ' +
        'Use it to find current information or the right page, then web_fetch a result URL to read it.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'The search query.' } },
        required: ['query']
      }
    },
    defaultPermission: 'allow',
    async execute(input: JSONValue): Promise<ToolResult> {
      const { query } = (input ?? {}) as { query?: string }
      if (!query || !query.trim()) return { toolUseId: '', content: 'web_search requires a "query".', isError: true }
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT)
      try {
        const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query.trim())}`, {
          signal: ctrl.signal,
          headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Cubex/0.1',
            accept: 'text/html'
          }
        })
        const html = await res.text()
        const hits = parseDuckDuckGoHtml(html)
        if (!hits.length) return { toolUseId: '', content: `No results for "${query}".` }
        const body = hits
          .map((h, n) => `${n + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ''}`)
          .join('\n\n')
        return { toolUseId: '', content: `Web results for "${query}":\n\n${body}` }
      } catch (e) {
        const msg = (e as Error).name === 'AbortError' ? `timed out after ${TIMEOUT}ms` : (e as Error).message
        return { toolUseId: '', content: `web_search failed: ${msg}`, isError: true }
      } finally {
        clearTimeout(timer)
      }
    }
  }
}
