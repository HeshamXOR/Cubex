import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { isInside } from '../acp/permissions'

/**
 * What Claude Code's tools are, in the words of the Agent Client Protocol, so the same policy that holds every other agent
 * to the chat's permission mode can hold this one: a kind (read, edit, execute, fetch...), the places it touches, the
 * change as a diff, and the command. Claude Code names its tools itself ("Edit", "Write", "Bash"), and a program can call
 * a tool anything, so a name that is not known is an "other" kind: it is asked about, never allowed by itself.
 */

export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other'

export interface ToolDiff {
  type: 'diff'
  path: string
  oldText: string | null
  newText: string
}

export interface ToolInfo {
  title: string
  kind: ToolKind
  locations?: Array<{ path: string; line?: number }>
  content?: ToolDiff[]
  rawInput: Record<string, unknown>
}

export interface ToolContext {
  /** The folder the session was started in: relative paths are read against it. */
  cwd: string
  /** What is in a file now, for the "before" of a diff. Only asked about files inside `cwd`. Undefined: not there, or not readable. */
  readCurrent?: (path: string) => string | undefined
}

/** A change that is not much bigger than a screenful: more than this of a file is not shown in a question. */
const DIFF_CHARS = 60_000
/** Files bigger than this are not read just to show what a change replaces. */
const READ_LIMIT_BYTES = 256 * 1024
/** What of a tool's input is kept as it was sent: the policy reads a command and a place, and the diff carries the text of an edit. */
const INPUT_STRING_CHARS = 4_000
const INPUT_ITEMS = 20
const INPUT_DEPTH = 4

const TITLE_CHARS = 120

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/** One line of what a program said, as a step's title: no control characters, not longer than a line. */
export function oneLine(value: string, limit = TITLE_CHARS): string {
  const line = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

function absolute(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path)
}

/** The path as the person reads it: relative to the project when it is inside it, with forward slashes. */
function shown(path: string, cwd: string): string {
  const full = absolute(path, cwd)
  const between = relative(cwd, full)
  const inside = between !== '' && between !== '..' && !between.startsWith(`..${sep}`) && !isAbsolute(between)
  return (inside ? between : full).split(sep).join('/')
}

function pathInput(input: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = text(input[name])
    if (value && !value.includes('\u0000')) return value
  }
  return undefined
}

/**
 * The folder a pattern starts in: what comes before its first wildcard, cut back to a whole folder. "src/**\/*.ts" starts in
 * "src", "C:/Users/*" in "C:/Users", and "*.ts" in the folder the search was started in. A pattern that is an address or that
 * climbs out with ".." names a place the search leaves the folder for, and is judged like any other place.
 */
export function patternBase(pattern: string): string {
  const wildcard = pattern.search(/[*?[\]{}]/)
  const literal = wildcard < 0 ? pattern : pattern.slice(0, wildcard)
  const cut = Math.max(literal.lastIndexOf('/'), literal.lastIndexOf('\\'))
  return wildcard < 0 ? literal : cut < 0 ? '' : literal.slice(0, cut + 1)
}

/** What a file holds now, when it is a small file inside the folder. */
export function readCurrentFile(path: string, cwd: string): string | undefined {
  try {
    if (!isInside(path, cwd)) return undefined
    const info = statSync(path)
    if (!info.isFile() || info.size > READ_LIMIT_BYTES) return undefined
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

const clipDiff = (value: string): string => (value.length > DIFF_CHARS ? value.slice(0, DIFF_CHARS) : value)

/** A tool's input with its long texts cut: a file written in one call is in the diff, and is not needed twice. */
export function clipInput(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > INPUT_STRING_CHARS ? `${value.slice(0, INPUT_STRING_CHARS)}…` : value
  if (depth >= INPUT_DEPTH) return undefined
  if (Array.isArray(value)) return value.slice(0, INPUT_ITEMS).map((entry) => clipInput(entry, depth + 1))
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value).slice(0, INPUT_ITEMS)) out[key] = clipInput(entry, depth + 1)
    return out
  }
  return value
}

function editDiffs(input: Record<string, unknown>, path: string, name: string, context: ToolContext): ToolDiff[] {
  if (name === 'Write') {
    const next = typeof input.content === 'string' ? input.content : undefined
    if (next === undefined) return []
    const before = (context.readCurrent ?? ((file: string) => readCurrentFile(file, context.cwd)))(path)
    return [{ type: 'diff', path, oldText: before === undefined ? null : clipDiff(before), newText: clipDiff(next) }]
  }
  if (name === 'Edit') {
    const next = typeof input.new_string === 'string' ? input.new_string : undefined
    const previous = typeof input.old_string === 'string' ? input.old_string : undefined
    return next === undefined ? [] : [{ type: 'diff', path, oldText: previous === undefined ? null : clipDiff(previous), newText: clipDiff(next) }]
  }
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    const out: ToolDiff[] = []
    for (const edit of input.edits) {
      if (!isRecord(edit) || typeof edit.new_string !== 'string') continue
      out.push({ type: 'diff', path, oldText: typeof edit.old_string === 'string' ? clipDiff(edit.old_string) : null, newText: clipDiff(edit.new_string) })
      if (out.length >= 5) break
    }
    return out
  }
  return []
}

const FILE_PATH = ['file_path', 'path']
const NOTEBOOK_PATH = ['notebook_path', 'file_path']

/** Claude Code's tool call as the protocol describes a tool call. */
export function describeTool(name: string, rawInput: Record<string, unknown>, context: ToolContext): ToolInfo {
  const { cwd } = context
  const input = rawInput
  const kept = (): Record<string, unknown> => clipInput(input) as Record<string, unknown>
  const places = (...paths: Array<{ path: string; line?: number } | undefined>): Pick<ToolInfo, 'locations'> => {
    const found = paths.filter((entry): entry is { path: string; line?: number } => entry !== undefined)
    return found.length > 0 ? { locations: found } : {}
  }
  const at = (path: string | undefined, line?: number): { path: string; line?: number } | undefined => (path ? { path: absolute(path, cwd), ...(line ? { line } : {}) } : undefined)

  switch (name) {
    case 'Read': {
      const path = pathInput(input, ...FILE_PATH)
      const offset = typeof input.offset === 'number' && Number.isInteger(input.offset) && input.offset > 0 ? input.offset : undefined
      return { title: path ? `Read ${shown(path, cwd)}` : 'Read a file', kind: 'read', ...places(at(path, offset)), rawInput: kept() }
    }
    case 'Write':
    case 'Edit':
    case 'MultiEdit': {
      const path = pathInput(input, ...FILE_PATH)
      const diffs = path ? editDiffs(input, absolute(path, cwd), name, context) : []
      const verb = name === 'Write' ? 'Write' : 'Edit'
      return { title: path ? `${verb} ${shown(path, cwd)}` : `${verb} a file`, kind: 'edit', ...places(at(path)), ...(diffs.length > 0 ? { content: diffs } : {}), rawInput: kept() }
    }
    case 'NotebookEdit': {
      const path = pathInput(input, ...NOTEBOOK_PATH)
      return { title: path ? `Edit ${shown(path, cwd)}` : 'Edit a notebook', kind: 'edit', ...places(at(path)), rawInput: kept() }
    }
    case 'Bash':
    case 'PowerShell': {
      const command = text(input.command)
      return { title: command ? `Run ${oneLine(command)}` : 'Run a command', kind: 'execute', rawInput: kept() }
    }
    case 'Glob': {
      const pattern = text(input.pattern)
      const start = pathInput(input, 'path')
      // A pattern with a place in it ("C:/Users/*/notes.txt", "../*") searches there, whatever folder was named.
      const base = pattern ? patternBase(pattern) : ''
      const named = base && (isAbsolute(base) || base.split(/[\\/]/).includes('..')) ? resolve(start ? absolute(start, cwd) : cwd, base) : undefined
      return { title: pattern ? `Find ${oneLine(pattern)}` : 'Find files', kind: 'search', ...places(at(start), named ? { path: named } : undefined), rawInput: kept() }
    }
    case 'Grep': {
      const pattern = text(input.pattern)
      return { title: pattern ? `Search for ${oneLine(pattern)}` : 'Search the project', kind: 'search', ...places(at(pathInput(input, 'path'))), rawInput: kept() }
    }
    case 'LS': {
      const path = pathInput(input, 'path')
      return { title: path ? `List ${shown(path, cwd)}` : 'List a folder', kind: 'search', ...places(at(path)), rawInput: kept() }
    }
    case 'WebFetch': {
      const url = text(input.url)
      return { title: url ? `Fetch ${oneLine(url)}` : 'Fetch a page', kind: 'fetch', rawInput: kept() }
    }
    case 'WebSearch': {
      const query = text(input.query)
      return { title: query ? `Search the web for ${oneLine(query)}` : 'Search the web', kind: 'fetch', rawInput: kept() }
    }
    case 'TodoWrite':
      return { title: 'Update the to-do list', kind: 'think', rawInput: kept() }
    case 'EnterPlanMode':
    case 'ExitPlanMode':
      return { title: 'Change the mode', kind: 'switch_mode', rawInput: kept() }
    default:
      // Anything else, including tools that start other agents or change the mode, is asked about and never allowed by itself.
      return { title: `Use ${oneLine(name, 60) || 'a tool'}`, kind: 'other', rawInput: kept() }
  }
}

/** The text of a tool's result, as far as a card would show it. A result is a string or a list of blocks, some of them text. */
export function resultText(content: unknown, limit = 2_000): string {
  if (typeof content === 'string') return content.slice(0, limit)
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') out += `${out ? '\n' : ''}${block.text}`
    if (out.length >= limit) break
  }
  return out.slice(0, limit)
}
