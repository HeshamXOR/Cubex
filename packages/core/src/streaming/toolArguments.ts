import type { JSONValue } from '../types/common'

/**
 * Reads the argument text of a streamed tool call. Strong models send one clean JSON object; weaker and open ones
 * (DeepSeek, Qwen, GLM, Kimi, NIM-hosted Llama, local models) often send something a little off: a code fence around
 * it, a trailing comma, Python's True/None, a raw newline inside a string, the object encoded twice, or a last brace
 * that never came. Each of those has one obvious meaning, so it is read rather than costing the turn.
 *
 * Nothing is ever invented: text that is still not JSON after these fixes (an unterminated string, a key with no
 * value, a reply cut off at the output limit) is reported as unparsed, never guessed at.
 */

export type ToolArgumentsParse =
  | { ok: true; value: JSONValue; repairs: string[] }
  | { ok: false; problem: string }

export interface ToolArgumentsOptions {
  /** The model finished its reply. Only then may a missing closing brace or bracket be supplied; after a cut-off it would hide the cut. */
  complete?: boolean
}

const MAX_UNWRAP = 3

/** The input a call carries when its arguments could not be read: the harness checks for exactly this shape (hasUnparsedCall). */
export function toolInputFromArguments(raw: string, options: ToolArgumentsOptions = {}): JSONValue {
  const parsed = parseToolArguments(raw, options)
  return parsed.ok ? parsed.value : { _raw: raw }
}

export function parseToolArguments(raw: string, options: ToolArgumentsOptions = {}, depth = 0): ToolArgumentsParse {
  const repairs: string[] = []
  let text = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).trim()
  if (!text) return { ok: true, value: {}, repairs }

  const direct = tryParse(text)
  if (direct.ok) return finish(direct.value, repairs, options, depth)

  const fenced = stripFence(text)
  if (fenced !== text) {
    repairs.push('removed a markdown code fence')
    text = fenced
    if (!text) return { ok: true, value: {}, repairs }
  }
  const unquoted = stripSurroundingQuotes(text)
  if (unquoted !== text) {
    repairs.push('removed the quotes around the arguments')
    text = unquoted
  }
  // Some servers send an empty "{}" first and the real arguments after it.
  const afterEmpty = text.replace(/^\{\s*\}\s*(?=\{)/, '')
  if (afterEmpty !== text) {
    repairs.push('dropped a leading empty object')
    text = afterEmpty
  }

  const second = tryParse(text)
  if (second.ok) return finish(second.value, repairs, options, depth)

  const scanned = rewrite(text, options.complete === true)
  if (!scanned.ok) return { ok: false, problem: scanned.problem }
  const third = tryParse(scanned.text)
  if (!third.ok) return { ok: false, problem: describe(text, third.message) }
  return finish(third.value, [...repairs, ...scanned.repairs], options, depth)
}

/** A short, specific reason the text is not JSON, for the message the model gets back. */
export function toolArgumentsProblem(raw: string, options: ToolArgumentsOptions = {}): string {
  const parsed = parseToolArguments(raw, options)
  return parsed.ok ? 'the arguments are valid JSON' : parsed.problem
}

function finish(value: unknown, repairs: string[], options: ToolArgumentsOptions, depth: number): ToolArgumentsParse {
  // A JSON string that itself holds the arguments: the model encoded them twice.
  if (typeof value === 'string') {
    const inner = value.trim()
    if (/^[{[]/.test(inner) || /^`{3}/.test(inner)) {
      if (depth >= MAX_UNWRAP) return { ok: false, problem: 'the arguments are wrapped in too many layers of JSON string encoding' }
      const parsed = parseToolArguments(inner, options, depth + 1)
      return parsed.ok
        ? { ok: true, value: parsed.value, repairs: [...repairs, 'decoded arguments that were a JSON string holding JSON', ...parsed.repairs] }
        : parsed
    }
    return { ok: true, value, repairs }
  }
  if (value === null) return { ok: true, value: {}, repairs: [...repairs, 'read null arguments as an empty object'] }
  return { ok: true, value: value as JSONValue, repairs }
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

function stripFence(text: string): string {
  if (!/^`{3,}/.test(text) && !/`{3,}$/.test(text)) return text
  return text
    .replace(/^`{3,}[A-Za-z0-9_-]*[ \t]*\r?\n?/, '')
    .replace(/\r?\n?[ \t]*`{3,}$/, '')
    .trim()
}

/** '{"a":1}' or `{"a":1}`: the whole text in one pair of single quotes or backticks around an object or array. */
function stripSurroundingQuotes(text: string): string {
  const first = text[0]
  if ((first === "'" || first === '`') && text.length > 2 && text.endsWith(first)) {
    const inner = text.slice(1, -1).trim()
    if (/^[{[]/.test(inner)) return inner
  }
  return text
}

type Rewrite = { ok: true; text: string; repairs: string[] } | { ok: false; problem: string }

const LITERALS: Record<string, string> = { True: 'true', False: 'false', None: 'null' }

/** One pass over the text that fixes what can be fixed without guessing, and gives up on the rest. */
function rewrite(text: string, complete: boolean): Rewrite {
  const found = new Set<string>()
  const out: string[] = []
  const stack: string[] = []
  let quote: string | undefined
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quote) {
      if (c === '\\') {
        const next = text[i + 1]
        if (next === undefined) break
        if (quote === "'" && next === "'") out.push("'")
        else out.push(c, next)
        i++
      } else if (c === quote) {
        out.push('"')
        quote = undefined
      } else if (quote === "'" && c === '"') out.push('\\"')
      else if (c < ' ') {
        found.add('escaped a raw line break or tab inside a string')
        out.push(c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
      } else out.push(c)
      continue
    }
    if (c === '"' || c === "'") {
      if (c === "'") found.add('read single-quoted strings')
      quote = c
      out.push('"')
    } else if (c === '{' || c === '[') {
      stack.push(c === '{' ? '}' : ']')
      out.push(c)
    } else if (c === '}' || c === ']') {
      stack.pop()
      out.push(c)
    } else if (c === ',') {
      if (/^\s*[}\]]/.test(text.slice(i + 1))) found.add('removed a trailing comma')
      else out.push(c)
    } else if (/[A-Za-z_$]/.test(c)) {
      let end = i + 1
      while (end < text.length && /[\w$]/.test(text[end]!)) end++
      const word = text.slice(i, end)
      i = end - 1
      if (word in LITERALS) {
        found.add('read Python True/False/None as JSON')
        out.push(LITERALS[word]!)
      } else if (stack[stack.length - 1] === '}' && /^\s*:/.test(text.slice(end))) {
        found.add('quoted bare property names')
        out.push(`"${word}"`)
      } else out.push(word)
    } else out.push(c)
  }
  if (quote) return { ok: false, problem: 'the arguments end inside an unfinished string, so the end of the call is missing' }
  if (stack.length) {
    if (!complete) return { ok: false, problem: `the arguments end before ${stack.length} open ${stack.length === 1 ? 'bracket' : 'brackets'} were closed, so the end of the call is missing` }
    while (out.length && /\s|,/.test(out[out.length - 1]!)) out.pop()
    out.push(...stack.reverse())
    found.add('closed a brace or bracket that never arrived')
  }
  return { ok: true, text: out.join(''), repairs: [...found] }
}

function describe(text: string, message: string): string {
  const at = /position (\d+)/.exec(message)
  if (at) {
    const index = Number(at[1])
    const near = text.slice(Math.max(0, index - 20), index + 20).replace(/\s+/g, ' ')
    return `the arguments are not valid JSON (${message.replace(/ in JSON at position \d+.*/, '')} near "${near}")`
  }
  return `the arguments are not valid JSON (${message})`
}
