import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/**
 * .gitignore matching for workspace listings and searches.
 *
 * Rules come from the workspace's own ignore files (root and nested) plus
 * .git/info/exclude; deeper files override shallower ones and later lines override
 * earlier ones, as in git. The files are untrusted (they ship inside cloned
 * repositories), so matching is a linear-time glob (no regular expressions, no
 * exponential backtracking) and files, lines and rule counts are bounded.
 */

const MAX_FILE_BYTES = 256 * 1024
const MAX_LINE_CHARACTERS = 1024
const MAX_RULES_PER_FILE = 5_000

type Token =
  | { kind: 'char'; value: string }
  | { kind: 'any' }
  | { kind: 'star' }
  | { kind: 'class'; negated: boolean; ranges: Array<[string, string]> }

const GLOBSTAR = Symbol('globstar')
type Segment = Token[] | typeof GLOBSTAR

interface Rule {
  negated: boolean
  dirOnly: boolean
  segments: Segment[]
}

/** One path component's glob: `*`, `?`, `[...]` classes and backslash escapes. */
function compileSegment(text: string, caseInsensitive: boolean): Token[] {
  const tokens: Token[] = []
  const fold = (value: string): string => (caseInsensitive ? value.toLowerCase() : value)
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '\\' && i + 1 < text.length) {
      tokens.push({ kind: 'char', value: fold(text[++i]!) })
    } else if (ch === '*') {
      if (tokens[tokens.length - 1]?.kind !== 'star') tokens.push({ kind: 'star' })
    } else if (ch === '?') {
      tokens.push({ kind: 'any' })
    } else if (ch === '[') {
      let j = i + 1
      const negated = text[j] === '!' || text[j] === '^'
      if (negated) j++
      const ranges: Array<[string, string]> = []
      let closed = false
      for (let first = true; j < text.length; j++, first = false) {
        const c = text[j]!
        if (c === ']' && !first) { closed = true; break }
        const low = c === '\\' && j + 1 < text.length ? text[++j]! : c
        if (text[j + 1] === '-' && j + 2 < text.length && text[j + 2] !== ']') {
          const high = text[j + 2] === '\\' && j + 3 < text.length ? text[j + 3]! : text[j + 2]!
          ranges.push([fold(low), fold(high)])
          j += text[j + 2] === '\\' && j + 3 < text.length ? 3 : 2
        } else ranges.push([fold(low), fold(low)])
      }
      if (closed) { tokens.push({ kind: 'class', negated, ranges }); i = j } else tokens.push({ kind: 'char', value: '[' })
    } else tokens.push({ kind: 'char', value: fold(ch) })
  }
  return tokens
}

function matchOne(token: Token, ch: string): boolean {
  if (token.kind === 'char') return token.value === ch
  if (token.kind === 'any') return true
  if (token.kind === 'class') return token.ranges.some(([low, high]) => ch >= low && ch <= high) !== token.negated
  return false
}

/** Wildcard match with one backtrack point: linear in practice, O(n*m) at worst. */
function matchTokens(tokens: readonly Token[], name: string): boolean {
  let t = 0
  let i = 0
  let star = -1
  let retry = 0
  while (i < name.length) {
    const token = tokens[t]
    if (token?.kind === 'star') { star = t++; retry = i }
    else if (token && matchOne(token, name[i]!)) { t++; i++ }
    else if (star >= 0) { t = star + 1; i = ++retry }
    else return false
  }
  while (tokens[t]?.kind === 'star') t++
  return t === tokens.length
}

/** Match whole path components; `**` spans zero or more of them. */
function matchSegments(segments: readonly Segment[], components: readonly string[]): boolean {
  let p = 0
  let n = 0
  let star = -1
  let retry = 0
  while (n < components.length) {
    const segment = segments[p]
    if (segment === GLOBSTAR) { star = p++; retry = n }
    else if (segment !== undefined && matchTokens(segment, components[n]!)) { p++; n++ }
    else if (star >= 0) { p = star + 1; n = ++retry }
    else return false
  }
  while (segments[p] === GLOBSTAR) p++
  return p === segments.length
}

function parseRule(raw: string, caseInsensitive: boolean): Rule | undefined {
  let line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
  if (!line || line.length > MAX_LINE_CHARACTERS || line.startsWith('#')) return undefined
  // Trailing spaces are dropped unless a backslash escapes them.
  let end = line.length
  while (end > 0 && line[end - 1] === ' ' && line[end - 2] !== '\\') end--
  line = line.slice(0, end)
  if (!line) return undefined
  const negated = line.startsWith('!')
  if (negated) line = line.slice(1)
  const dirOnly = line.endsWith('/')
  if (dirOnly) line = line.slice(0, -1)
  const anchoredByLeadingSlash = line.startsWith('/')
  if (anchoredByLeadingSlash) line = line.slice(1)
  const parts = line.split('/').filter(Boolean)
  if (parts.length === 0) return undefined
  // A slash anywhere but the end ties the pattern to the folder of its ignore file; otherwise any depth matches.
  const anchored = anchoredByLeadingSlash || parts.length > 1
  const segments: Segment[] = parts.map((part) => (part === '**' ? GLOBSTAR : compileSegment(part, caseInsensitive)))
  if (!anchored) segments.unshift(GLOBSTAR)
  // "dir/**" means everything inside dir, not dir itself.
  if (segments[segments.length - 1] === GLOBSTAR) segments.push([{ kind: 'star' }])
  return { negated, dirOnly, segments }
}

function parseRules(text: string, caseInsensitive: boolean): Rule[] {
  const rules: Rule[] = []
  for (const line of text.split('\n')) {
    if (rules.length >= MAX_RULES_PER_FILE) break
    const rule = parseRule(line, caseInsensitive)
    if (rule) rules.push(rule)
  }
  return rules
}

export class GitIgnore {
  private readonly levels = new Map<string, Rule[]>()
  private readonly caseInsensitive: boolean

  /** `caseInsensitive` defaults to the platform's git behavior: on for Windows. */
  constructor(private readonly root: string, options: { caseInsensitive?: boolean } = {}) {
    this.caseInsensitive = options.caseInsensitive ?? process.platform === 'win32'
  }

  /**
   * Read the ignore files that govern `dir` (workspace-relative, '/' separated, '' for the
   * root): every ancestor's and its own. Pass `hasIgnoreFile: false` when a directory
   * listing already showed there is none, to skip the lookup.
   */
  async load(dir: string, hasIgnoreFile?: boolean): Promise<void> {
    const parts = dir ? dir.split('/').filter(Boolean) : []
    for (let depth = 0; depth <= parts.length; depth++) {
      const key = parts.slice(0, depth).join('/')
      if (this.levels.has(key)) continue
      this.levels.set(key, depth === parts.length && hasIgnoreFile === false ? [] : await this.read(parts.slice(0, depth)))
    }
  }

  private async read(parts: string[]): Promise<Rule[]> {
    // The root also honors .git/info/exclude, with lower priority than any .gitignore.
    const files = parts.length === 0
      ? [join(this.root, '.git', 'info', 'exclude'), join(this.root, '.gitignore')]
      : [join(this.root, ...parts, '.gitignore')]
    const rules: Rule[] = []
    for (const file of files) {
      try {
        const stat = await fs.lstat(file)
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue
        rules.push(...parseRules(await fs.readFile(file, 'utf8'), this.caseInsensitive))
      } catch { /* missing, unreadable, or a symlink: no rules */ }
    }
    return rules
  }

  /**
   * Whether this entry (workspace-relative, '/' separated) is ignored by the rules of the
   * folders above it. Only the entry itself is judged: a caller that already chose to look
   * inside an ignored folder does not have that folder's own rule applied to its contents.
   */
  ignores(path: string, isDirectory: boolean): boolean {
    const components = path.split('/').filter(Boolean)
    const names = this.caseInsensitive ? components.map((part) => part.toLowerCase()) : components
    let ignored = false
    for (let depth = 0; depth < components.length; depth++) {
      const rules = this.levels.get(components.slice(0, depth).join('/'))
      if (!rules || rules.length === 0) continue
      const rest = names.slice(depth)
      for (const rule of rules) {
        if (rule.dirOnly && !isDirectory) continue
        if (matchSegments(rule.segments, rest)) ignored = !rule.negated
      }
    }
    return ignored
  }
}
