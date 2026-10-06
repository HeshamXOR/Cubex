/**
 * Spotting file paths in the conversation: `src/app.ts`, `src/app.ts:42`, `app.ts:42:7`, `src/app.ts#L42`,
 * and the `app.ts(42,7)` form TypeScript prints. Whether the file exists is for the main process to say;
 * this only decides what is worth asking about.
 */

interface PathReference {
  /** The path as written, trimmed, without a leading ./ or a trailing slash. */
  path: string
  /** 1-based line the text pointed at. */
  line?: number
  column?: number
}

const MAX_LENGTH = 260
const MAX_LINE = 9_999_999

/** Names that are files without an extension. Other bare words are far more often identifiers. */
const PLAIN_FILES: ReadonlySet<string> = new Set([
  'Makefile', 'Dockerfile', 'Procfile', 'Gemfile', 'Rakefile', 'Jenkinsfile', 'Vagrantfile', 'LICENSE', 'README', 'CHANGELOG', 'CODEOWNERS', 'NOTICE'
])

/** A position after the path. Each has the line as its first group and the column as its optional second. */
const POSITIONS: readonly RegExp[] = [
  /#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/,
  /\((\d+)(?:,\s?(\d+))?\)$/,
  /:(\d+)(?::(\d+))?(?:-\d+)?$/
]

const toNumber = (value: string | undefined): number | undefined => {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_LINE ? parsed : undefined
}

/** Reads a path with an optional line position out of text, or null when the text does not look like one. */
export function parsePathReference(raw: string): PathReference | null {
  let text = raw.trim()
  if (!text || text.length > MAX_LENGTH + 20) return null
  if (/\s/.test(text) || /[<>"'|?*`]/.test(text) || text.includes('://') || /^[-@#]/.test(text)) return null

  let line: number | undefined
  let column: number | undefined
  for (const pattern of POSITIONS) {
    const match = pattern.exec(text)
    if (!match) continue
    line = toNumber(match[1])
    column = toNumber(match[2])
    text = text.slice(0, match.index)
    break
  }

  text = text.replace(/^\.[\\/]/, '').replace(/[\\/]+$/, '')
  if (!text || text.length > MAX_LENGTH || text.endsWith('.')) return null
  // A colon is only allowed in a drive letter.
  if (text.includes(':') && !/^[A-Za-z]:[\\/][^:]*$/.test(text)) return null

  const name = text.split(/[\\/]/).pop() ?? ''
  if (!name || /^\.+$/.test(name)) return null
  // Needs a real extension (with a letter, so version numbers and times do not count), a well-known bare
  // name, or a folder-like name inside a folder. The main process settles the rest.
  const hasExtension = /\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(name)
  const folderLike = /[\\/]/.test(text) && /^[\w-]+$/.test(name)
  if (!hasExtension && !folderLike && !PLAIN_FILES.has(name)) return null

  return { path: text, ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}) }
}

/** Folders above a path, outermost first: `a/b/c.ts` gives `a` and `a/b`. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split('/').filter(Boolean)
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'))
}
