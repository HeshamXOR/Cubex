import type { JSONSchema, JSONValue, ToolCall } from '@core/types'
import { parseToolArguments, toolArgumentsProblem } from '@core/streaming/toolArguments'
import { mapXmlToolCall } from '@core/tools/xmlToolCalls'
import { isUnparsedInput } from './outputCutoff'

/**
 * Weaker and open models (DeepSeek, Qwen, GLM, Kimi, NIM-hosted Llama, local models) call the right tool in slightly
 * the wrong way: "Read-File" or "functions.read_file:0" for read_file, "5" for a number, one string for a list of
 * strings, the arguments nested one level too deep. Each has one obvious meaning, so the call is mended and run
 * instead of costing a turn. When it cannot be mended the model gets a message that names the tool, the problem, the
 * shape it wanted and an example, so its next call is right.
 *
 * Pure: no tool runs here. The agent loop calls repairToolCall on each call before it checks permissions and runs it.
 */

export interface RepairableTool {
  name: string
  inputSchema: JSONSchema
}

export type RepairResult =
  /** `call` is the same object when nothing needed mending; `repairs` says what changed, for the log. */
  | { call: ToolCall; repairs: string[] }
  /** Written for the model: send it back as the call's error result. */
  | { error: string }

export function repairToolCall(call: ToolCall, tools: readonly RepairableTool[]): RepairResult {
  const repairs: string[] = []
  let name = call.name
  let input: unknown = call.input
  let tool = tools.find((t) => t.name === name)

  if (!tool) {
    const found = resolveName(call.name, input, tools)
    if (!found) return { error: unknownToolMessage(call.name, tools) }
    tool = found.tool
    name = tool.name
    if (found.input !== undefined) input = found.input
    repairs.push(`tool name "${call.name}" -> "${name}"`)
  }

  const schema = tool.inputSchema
  if (isUnparsedInput(input)) {
    const raw = (input as { _raw: string })._raw
    return { error: failure(tool, `its arguments were not valid JSON, so it was not run: ${toolArgumentsProblem(raw)}. What arrived began: ${excerpt(raw)}`) }
  }

  // Arguments that reached a call as text (a text-emitted call, an adapter that skipped the accumulator).
  if (typeof input === 'string') {
    const parsed = /^\s*[{[`]/.test(input) ? parseToolArguments(input) : undefined
    if (parsed?.ok) {
      input = parsed.value
      repairs.push(...parsed.repairs)
    } else if (parsed) return { error: failure(tool, `its arguments were not valid JSON, so it was not run: ${parsed.problem}. What arrived began: ${excerpt(input)}`) }
    else if (!input.trim()) {
      input = {}
      repairs.push('read empty arguments as {}')
    }
  }
  if (input === null || input === undefined) {
    input = {}
    repairs.push('read missing arguments as {}')
  }

  const props = schema.properties ?? {}
  // {"input": {...}}, {"arguments": "{...}"}: the real arguments one level down.
  for (let layer = 0; layer < 2 && isObject(input); layer++) {
    const keys = Object.keys(input)
    const key = keys.length === 1 && WRAPPER_KEYS.includes(keys[0]!.toLowerCase()) && !(keys[0]! in props) ? keys[0]! : undefined
    if (!key) break
    let inner = input[key]
    if (typeof inner === 'string') {
      const parsed = parseToolArguments(inner)
      if (parsed.ok) inner = parsed.value
    }
    if (!isObject(inner)) break
    input = inner
    repairs.push(`arguments were nested under "${key}"`)
  }

  // A bare value for a tool with one required property: read_file("src/a.ts").
  if (!isObject(input)) {
    const only = soleRequired(schema)
    if (!only) return { error: failure(tool, `it was called with ${describeValue(input)} instead of a JSON object`) }
    input = { [only]: input }
    repairs.push(`wrapped the bare value as "${only}"`)
  }

  const problems: string[] = []
  const fixed = coerce(input, schema, '', repairs, problems)
  if (problems.length) return { error: failure(tool, problems.join('; ')) }
  if (!repairs.length) return { call, repairs }
  return { call: { ...call, name, input: fixed as JSONValue }, repairs }
}

const WRAPPER_KEYS = ['input', 'arguments', 'parameters', 'params', 'args']
/** A prefix a model puts in front of a tool name: functions.read_file, default_api:read_file, tools/read_file. */
const NAMESPACE_PREFIX = /^(?:[A-Za-z_][\w-]*)[.:/]/

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const squash = (s: string): string => s.toLowerCase().replace(/[\s_-]+/g, '')

interface Resolved {
  tool: RepairableTool
  /** Replaces the call's input when an alias also renames its arguments (fs_read's `file` becomes `path`). */
  input?: unknown
}

function resolveName(raw: string, input: unknown, tools: readonly RepairableTool[]): Resolved | undefined {
  const names = [raw.trim()]
  // Kimi numbers its calls: functions.read_file:0
  let stripped = raw.trim().replace(/:\d+$/, '')
  names.push(stripped)
  while (NAMESPACE_PREFIX.test(stripped)) {
    stripped = stripped.replace(NAMESPACE_PREFIX, '')
    names.push(stripped)
  }
  for (const name of names) {
    const exact = tools.find((t) => t.name === name)
    if (exact) return { tool: exact }
    // Case, dashes and underscores only; two tools that differ by nothing else are not guessed between.
    const alike = tools.filter((t) => squash(t.name) === squash(name))
    if (alike.length === 1) return { tool: alike[0]! }
  }
  // Names other agent harnesses use (fs_read, execute_bash, grep, ...), mapped the same way as text-emitted calls.
  const available = new Set(tools.map((t) => t.name))
  const params = isObject(input) && Object.values(input).every((v) => typeof v === 'string') ? (input as Record<string, string>) : undefined
  for (const name of names) {
    const mapped = mapXmlToolCall({ name, params: params ?? {} }, available)
    const tool = tools.find((t) => t.name === mapped.name)
    // The mapping fills in "" for a path or text the model left out; a missing argument is reported, not made up.
    if (tool) return { tool, ...(params ? { input: Object.fromEntries(Object.entries(mapped.input).filter(([, v]) => v !== '' || Object.values(params).includes(''))) } : {}) }
  }
  return undefined
}

function unknownToolMessage(name: string, tools: readonly RepairableTool[]): string {
  const near = closest(name, tools.map((t) => t.name))
  const list = tools.slice(0, 40).map((t) => t.name).join(', ') + (tools.length > 40 ? `, and ${tools.length - 40} more` : '')
  return `There is no tool named "${name}", so nothing was run.${near ? ` Did you mean "${near}"?` : ''} The tools you can call are: ${list || '(none)'}. Call one of them by exactly that name.`
}

function closest(name: string, candidates: string[]): string | undefined {
  const target = squash(name.replace(NAMESPACE_PREFIX, ''))
  let best: { name: string; distance: number } | undefined
  for (const candidate of candidates) {
    const c = squash(candidate)
    const distance = c.includes(target) || target.includes(c) ? 1 : editDistance(c, target)
    if (distance <= Math.max(2, Math.floor(c.length / 4)) && (!best || distance < best.distance)) best = { name: candidate, distance }
  }
  return best?.name
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = row
  }
  return prev[b.length]!
}

function soleRequired(schema: JSONSchema): string | undefined {
  const required = schema.required ?? []
  return required.length === 1 && schema.properties?.[required[0]!] ? required[0] : undefined
}

// --- coercion -------------------------------------------------------------------------------------------------

/** A schema this module does not try to read (unions, references): its values pass through untouched. */
const opaque = (s: JSONSchema): boolean => Array.isArray(s.type) || ['anyOf', 'oneOf', 'allOf', 'not', '$ref'].some((k) => k in s)

function schemaType(s: JSONSchema): string | undefined {
  if (typeof s.type === 'string') return s.type
  return s.properties ? 'object' : s.items ? 'array' : undefined
}

const at = (path: string, key: string | number): string => (typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key)
const label = (path: string): string => (path ? `"${path}"` : 'the input')

function coerce(value: unknown, schema: JSONSchema, path: string, repairs: string[], problems: string[]): unknown {
  if (opaque(schema)) return value
  const type = schemaType(schema)
  let out = value
  switch (type) {
    case 'string':
      if (typeof value === 'number' || typeof value === 'boolean') {
        out = String(value)
        repairs.push(`${label(path)} sent as ${typeof value}, made a string`)
      } else if (typeof value !== 'string') mismatch(path, 'a string', value, problems)
      break
    case 'number':
    case 'integer': {
      let n = value
      if (typeof value === 'string' && /^\s*-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\s*$/.test(value)) {
        n = Number(value)
        repairs.push(`${label(path)} sent as a string, made a number`)
      }
      if (typeof n !== 'number' || !Number.isFinite(n)) mismatch(path, type === 'integer' ? 'an integer' : 'a number', value, problems)
      else if (type === 'integer' && !Number.isInteger(n)) problems.push(`${label(path)} must be a whole number, got ${n}`)
      out = n
      break
    }
    case 'boolean':
      if (typeof value === 'string' && /^\s*(?:true|false)\s*$/i.test(value)) {
        out = value.trim().toLowerCase() === 'true'
        repairs.push(`${label(path)} sent as a string, made a boolean`)
      } else if (typeof value !== 'boolean') mismatch(path, 'true or false', value, problems)
      break
    case 'array':
      out = coerceArray(value, schema, path, repairs, problems)
      break
    case 'object':
      out = coerceObject(value, schema, path, repairs, problems)
      break
    case 'null':
      if (value !== null) mismatch(path, 'null', value, problems)
      break
  }
  if (schema.enum && !schema.enum.some((e) => e === out)) {
    const same = typeof out === 'string' ? schema.enum.find((e) => typeof e === 'string' && squash(e) === squash(out as string)) : undefined
    if (same !== undefined) {
      repairs.push(`${label(path)} "${String(out)}" -> "${String(same)}"`)
      out = same
    } else problems.push(`${label(path)} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}, got ${describeValue(out)}`)
  }
  return out
}

function coerceArray(value: unknown, schema: JSONSchema, path: string, repairs: string[], problems: string[]): unknown {
  let list: unknown[]
  if (Array.isArray(value)) list = value
  else {
    let parsed: unknown
    if (typeof value === 'string' && /^\s*[[`]/.test(value)) {
      const p = parseToolArguments(value)
      if (p.ok && Array.isArray(p.value)) parsed = p.value
    }
    if (parsed) {
      list = parsed as unknown[]
      repairs.push(`${label(path)} sent as a JSON string, decoded`)
    } else if (value === undefined || value === null || !schema.items || Array.isArray(schema.items)) {
      mismatch(path, 'a list', value, problems)
      return value
    } else {
      list = [value]
      repairs.push(`${label(path)} sent as a single value, made a list of one`)
    }
  }
  const items = schema.items
  if (!items || Array.isArray(items)) return list
  return list.map((item, i) => coerce(item, items, at(path, i), repairs, problems))
}

function coerceObject(value: unknown, schema: JSONSchema, path: string, repairs: string[], problems: string[]): unknown {
  let obj = value
  if (typeof obj === 'string' && /^\s*[{`]/.test(obj)) {
    const p = parseToolArguments(obj)
    if (p.ok && isObject(p.value)) {
      obj = p.value
      repairs.push(`${label(path)} sent as a JSON string, decoded`)
    }
  }
  if (!isObject(obj)) {
    mismatch(path, 'an object', value, problems)
    return value
  }
  const props = schema.properties ?? {}
  const required = new Set(schema.required ?? [])
  const result: Record<string, unknown> = {}
  const extra: [string, unknown][] = []
  for (const [key, v] of Object.entries(obj)) {
    if (key in props) result[key] = v
    else extra.push([key, v])
  }
  for (const [key, v] of extra) {
    // filePath, FilePath and file-path for file_path.
    const like = Object.keys(props).filter((p) => squash(p) === squash(key) && !(p in result))
    if (like.length === 1) {
      result[like[0]!] = v
      repairs.push(`${label(at(path, key))} -> "${at(path, like[0]!)}"`)
    } else if (schema.additionalProperties === false) repairs.push(`dropped unknown property "${at(path, key)}"`)
    else if (isObject(schema.additionalProperties)) result[key] = coerce(v, schema.additionalProperties, at(path, key), repairs, problems)
    else result[key] = v
  }
  for (const [key, propSchema] of Object.entries(props)) {
    if (!(key in result)) {
      if (required.has(key)) problems.push(`${label(at(path, key))} is required but missing`)
      continue
    }
    // null for an optional property means "not given".
    if (result[key] === null && !required.has(key) && propSchema.type !== 'null' && !opaque(propSchema)) {
      delete result[key]
      repairs.push(`dropped null for optional "${at(path, key)}"`)
      continue
    }
    result[key] = coerce(result[key], propSchema, at(path, key), repairs, problems)
  }
  return result
}

function mismatch(path: string, wanted: string, value: unknown, problems: string[]): void {
  problems.push(`${label(path)} must be ${wanted}, got ${describeValue(value)}`)
}

function describeValue(v: unknown): string {
  if (v === null) return 'null'
  if (v === undefined) return 'nothing'
  if (Array.isArray(v)) return 'a list'
  if (typeof v === 'object') return 'an object'
  if (typeof v === 'string') return `the string ${JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}...` : v)}`
  return `the ${typeof v} ${String(v)}`
}

// --- messages for the model -----------------------------------------------------------------------------------

function excerpt(raw: string): string {
  const flat = raw.replace(/\s+/g, ' ').trim()
  return JSON.stringify(flat.length > 160 ? `${flat.slice(0, 160)}...` : flat)
}

/** "The call to X was not run: <problem>. It takes {...}. Example: {...}." */
function failure(tool: RepairableTool, problem: string): string {
  return `The "${tool.name}" call was not run: ${problem}. ` +
    `"${tool.name}" takes ${shape(tool.inputSchema)}. Example: ${JSON.stringify(example(tool.inputSchema))}. ` +
    'Send the call again with one JSON object of that shape.'
}

function typeName(s: JSONSchema): string {
  if (s.enum) return s.enum.map((e) => JSON.stringify(e)).join(' | ')
  const type = schemaType(s)
  if (type === 'array') return `${s.items && !Array.isArray(s.items) ? typeName(s.items) : 'value'}[]`
  return Array.isArray(s.type) ? s.type.join(' | ') : (type ?? 'any')
}

function shape(schema: JSONSchema): string {
  const props = Object.entries(schema.properties ?? {})
  if (!props.length) return 'an empty object {}'
  const required = new Set(schema.required ?? [])
  return `{ ${props.map(([k, s]) => `"${k}": ${typeName(s)}${required.has(k) ? ' (required)' : ''}`).join(', ')} }`
}

/** The smallest valid input: required properties only, with a placeholder of the right type. */
function example(schema: JSONSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of schema.required ?? []) out[key] = sample(schema.properties?.[key] ?? {}, key)
  return out
}

function sample(s: JSONSchema, key: string): unknown {
  if (s.enum?.length) return s.enum[0]
  switch (schemaType(s)) {
    case 'string': return `<${key}>`
    case 'number': case 'integer': return 1
    case 'boolean': return true
    case 'array': return s.items && !Array.isArray(s.items) ? [sample(s.items, key)] : []
    case 'object': return s.properties ? example(s) : {}
    default: return null
  }
}
