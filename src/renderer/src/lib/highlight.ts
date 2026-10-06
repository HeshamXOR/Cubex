/**
 * A small single-line syntax highlighter for diffs. Diff rows are shown out of
 * context, so multi-line constructs cannot be tracked; each line is colored on
 * its own, which is what a reviewer needs to read a change.
 */

export type TokenClass = 'k' | 'f' | 's' | 't' | 'n' | 'c' | 'o' | 'p'
export type Lang = 'js' | 'py' | 'c' | 'json' | 'css' | 'sh' | 'yaml' | 'md' | 'plain'

export interface Token { text: string; cls?: TokenClass }
export interface Piece extends Token { marked?: boolean }

const words = (list: string): Set<string> => new Set(list.split(/\s+/).filter(Boolean))

const KEYWORDS: Partial<Record<Lang, Set<string>>> = {
  js: words(`import export from default as async await function return const let var if else for while do switch case break
    continue throw try catch finally new typeof instanceof void delete in of class extends super this null undefined true false
    interface type enum implements public private protected readonly static abstract declare namespace module yield get set
    satisfies keyof`),
  py: words(`def class return if elif else for while in not and or is None True False import from as with try except finally
    raise lambda pass break continue yield async await global nonlocal assert del self`),
  c: words(`fn let mut pub use mod struct enum impl trait match if else for while loop return break continue const static unsafe
    async await func package import type interface go defer chan select range var int void char long float double bool class
    public private protected new this null true false using namespace template typename include define extends implements`),
  sh: words('if then else elif fi for do done while until case esac function return export local in set unset source alias exit'),
  json: words('true false null'),
  yaml: words('true false null yes no')
}
const TYPES = words('string number boolean unknown any never object symbol bigint void int str float bool')

const EXTENSIONS: Record<string, Lang> = {
  ts: 'js', tsx: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', mts: 'js', cts: 'js',
  py: 'py', pyw: 'py',
  rs: 'c', go: 'c', java: 'c', kt: 'c', cs: 'c', c: 'c', h: 'c', cpp: 'c', cc: 'c', hpp: 'c', swift: 'c', php: 'c',
  json: 'json', jsonc: 'json',
  css: 'css', scss: 'css', less: 'css',
  sh: 'sh', bash: 'sh', zsh: 'sh', ps1: 'sh',
  yml: 'yaml', yaml: 'yaml', toml: 'yaml',
  md: 'md', mdx: 'md'
}

export function languageFor(path: string): Lang {
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot < 0 ? 'plain' : EXTENSIONS[name.slice(dot + 1).toLowerCase()] ?? 'plain'
}

const LINE_COMMENT = String.raw`\/\/.*$`
const BLOCK_COMMENT = String.raw`\/\*.*?(?:\*\/|$)`
const COMMENT: Partial<Record<Lang, string>> = {
  js: `${LINE_COMMENT}|${BLOCK_COMMENT}`,
  c: `${LINE_COMMENT}|${BLOCK_COMMENT}`,
  css: BLOCK_COMMENT,
  py: '#.*$',
  sh: '#.*$',
  yaml: '#.*$'
}

const cache = new Map<Lang, RegExp>()

function patternFor(lang: Lang): RegExp {
  let pattern = cache.get(lang)
  if (!pattern) {
    const comment = COMMENT[lang] ?? '(?!)'
    pattern = new RegExp(
      `(?<comment>${comment})|(?<string>'(?:[^'\\\\]|\\\\.)*'?|"(?:[^"\\\\]|\\\\.)*"?|\`(?:[^\`\\\\]|\\\\.)*\`?)` +
      String.raw`|(?<number>\b0x[\da-fA-F_]+\b|\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b)|(?<ident>[A-Za-z_$][\w$-]*)|(?<space>\s+)|(?<punct>[^\sA-Za-z_$\d'"` + '`])',
      'g'
    )
    cache.set(lang, pattern)
  }
  pattern.lastIndex = 0
  return pattern
}

/** Split one line into colored tokens that together reproduce the line exactly. */
export function tokenizeLine(text: string, lang: Lang): Token[] {
  if (lang === 'plain') return [{ text }]
  if (lang === 'md') return [/^\s{0,3}#{1,6}\s/.test(text) ? { text, cls: 'k' } : { text }]
  const keywords = KEYWORDS[lang]
  const tokens: Token[] = []
  const pattern = patternFor(lang)
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    const groups = match.groups!
    const value = match[0]
    const rest = text.slice(pattern.lastIndex)
    if (groups.comment) tokens.push({ text: value, cls: 'c' })
    else if (groups.string) {
      // In JSON and YAML a string followed by a colon is a key.
      const key = (lang === 'json' || lang === 'yaml') && /^\s*:/.test(rest)
      tokens.push({ text: value, cls: key ? 'f' : 's' })
    } else if (groups.number) tokens.push({ text: value, cls: 'n' })
    else if (groups.ident) {
      let cls: TokenClass | undefined
      if (keywords?.has(value)) cls = 'k'
      else if (TYPES.has(value) || (lang !== 'css' && lang !== 'sh' && lang !== 'yaml' && /^[A-Z]/.test(value))) cls = 't'
      else if (lang === 'css' && /^\s*:/.test(rest)) cls = 'f'
      else if (lang === 'yaml' && /^\s*:(\s|$)/.test(rest)) cls = 'f'
      else if (/^\s*\(/.test(rest) || (lang === 'js' && /^\s*=\s*(async\s*)?\(/.test(rest))) cls = 'f'
      else if (/^\s*:(?!:)/.test(rest) && lang !== 'sh') cls = 'p'
      tokens.push({ text: value, cls })
    } else if (groups.space) tokens.push({ text: value })
    else tokens.push({ text: value, cls: 'o' })
  }
  return tokens
}

/**
 * Colored pieces of a line with word-level emphasis applied. Pieces are split at the edges
 * of each marked range, so every piece is either wholly marked or not.
 */
export function pieces(text: string, lang: Lang, marks: ReadonlyArray<readonly [number, number]> = []): Piece[] {
  const tokens = tokenizeLine(text, lang)
  if (!marks.length) return tokens
  const out: Piece[] = []
  let offset = 0
  for (const token of tokens) {
    const end = offset + token.text.length
    let cursor = offset
    for (const [markStart, markEnd] of marks) {
      if (markEnd <= cursor || markStart >= end) continue
      const from = Math.max(markStart, cursor)
      const to = Math.min(markEnd, end)
      if (from > cursor) out.push({ text: text.slice(cursor, from), cls: token.cls })
      out.push({ text: text.slice(from, to), cls: token.cls, marked: true })
      cursor = to
    }
    if (cursor < end) out.push({ text: text.slice(cursor, end), cls: token.cls })
    offset = end
  }
  return out
}
