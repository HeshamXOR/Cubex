import { Script, createContext } from 'node:vm'

/**
 * Line-by-line matching for search_files, with a hard time limit for regular expressions.
 *
 * A JavaScript regex can backtrack catastrophically ((a+)+$ on a long line of a's runs for
 * minutes) and cannot be interrupted from the same thread. Running the match inside a
 * vm context with a timeout lets V8 terminate it, so a model-supplied pattern can slow a
 * search down by at most the budget, never hang the app. The pattern is only ever data in
 * that context; it never becomes code.
 */

export class RegexTimeout extends Error {
  /** 0-based indexes of the lines that matched before the budget ran out. */
  constructor(readonly partial: number[]) { super('regular expression timed out') }
}

export const MAX_REGEX_CHARACTERS = 500

export interface LineMatcher {
  /** 0-based indexes of the lines of `text` that match, up to `maxHits`. A regex matcher throws RegexTimeout past `timeoutMs`. */
  matchingLines(text: string, maxHits: number, timeoutMs: number): number[]
}

/** Plain substring matching; `caseSensitive: false` compares lower-cased lines. */
export function createLiteralMatcher(query: string, caseSensitive: boolean): LineMatcher {
  const needle = caseSensitive ? query : query.toLowerCase()
  return {
    matchingLines(text, maxHits) {
      const hits: number[] = []
      const lines = text.split('\n')
      for (let index = 0; index < lines.length && hits.length < maxHits; index++) {
        if ((caseSensitive ? lines[index]! : lines[index]!.toLowerCase()).includes(needle)) hits.push(index)
      }
      return hits
    }
  }
}

// Compiled once and reused. Only plain data crosses into the context. The hits live in
// the context's global so the ones found before a timeout can still be read afterwards.
const SCRIPT = new Script(`(() => {
  const re = new RegExp(source, flags)
  const lines = text.split('\\n')
  hits = []
  for (let i = 0; i < lines.length && hits.length < max; i++) {
    const line = lines[i]
    // A CRLF file must not make "$" miss the end of a line.
    if (re.test(line.charCodeAt(line.length - 1) === 13 ? line.slice(0, -1) : line)) hits.push(i)
  }
})()`)

interface RegexSandbox { source: string; flags: string; text: string; max: number; hits?: number[] }

/** Throws a SyntaxError (with V8's message) for an invalid pattern. */
export function createRegexMatcher(source: string, caseSensitive: boolean): LineMatcher {
  const flags = caseSensitive ? '' : 'i'
  // Compile in this realm first so a syntax error surfaces with its normal message, before any work starts.
  new RegExp(source, flags)
  const sandbox: RegexSandbox = { source, flags, text: '', max: 0 }
  const context = createContext(sandbox)
  return {
    matchingLines(text, maxHits, timeoutMs) {
      sandbox.text = text
      sandbox.max = maxHits
      try {
        SCRIPT.runInContext(context, { timeout: Math.max(1, Math.floor(timeoutMs)) })
        return Array.from(sandbox.hits ?? [])
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw new RegexTimeout(Array.from(sandbox.hits ?? []))
        throw error
      } finally {
        // Do not keep a large file alive between calls.
        sandbox.text = ''
        sandbox.hits = undefined
      }
    }
  }
}
