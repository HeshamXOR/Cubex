/**
 * JSON Schema to the OpenAPI 3.0 subset Gemini accepts for
 * `FunctionDeclaration.parameters` and `responseSchema`.
 *
 * Tool schemas come from zod, MCP servers and hand-written definitions, so they
 * use whatever JSON Schema dialect their author knew. The Gemini API rejects
 * keywords outside its subset with a 400, which would make one odd tool break
 * every request, so this converts instead of passing through:
 *  - `$ref` is inlined (a recursive reference is cut), definitions are dropped;
 *  - `type` arrays, `anyOf`/`oneOf` with a null branch and null enum members
 *    become `nullable`; real alternatives become `anyOf`; `allOf` is merged;
 *  - `enum` stays only for strings (the subset has string enums), `const` becomes
 *    a one-value enum or a constraint stated in the description;
 *  - keywords with no equivalent (`additionalProperties`, `$schema`, ...) go.
 * Constraints that cannot be expressed are moved into the description so the
 * model still sees them. The input is never mutated.
 */

export interface GeminiSchema {
  type?: string
  description?: string
  format?: string
  nullable?: boolean
  enum?: string[]
  items?: GeminiSchema
  properties?: Record<string, GeminiSchema>
  required?: string[]
  anyOf?: GeminiSchema[]
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
  minLength?: number
  maxLength?: number
  pattern?: string
}

type Json = Record<string, unknown>

interface Ctx {
  root: Json
  /** Refs being expanded right now; meeting one again means a cycle. */
  refs: string[]
}

/** Deeper than any real tool schema; stops pathological or hostile input. */
const MAX_DEPTH = 24

const KNOWN_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'])

/** Formats the API documents per type; others carry no behavior, so they become a hint. */
const FORMATS: Record<string, readonly string[]> = {
  string: ['enum', 'date-time'],
  integer: ['int32', 'int64'],
  number: ['float', 'double']
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Add a sentence to a description, closing the previous sentence first. */
function appendDescription(base: string | undefined, extra: string): string {
  const text = base?.trim()
  if (!text) return extra
  return /[.!?:]$/.test(text) ? `${text} ${extra}` : `${text}. ${extra}`
}

/** Resolve a local `#/...` JSON pointer; anything else (URLs, anchors) is unresolvable. */
function resolvePointer(root: Json, ref: string): unknown {
  if (ref === '#') return root
  if (!ref.startsWith('#/')) return undefined
  let current: unknown = root
  for (const raw of ref.slice(2).split('/')) {
    let key = raw
    try {
      key = decodeURIComponent(raw)
    } catch {
      // keep the raw segment
    }
    key = key.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!isObject(current) && !Array.isArray(current)) return undefined
    current = (current as Json)[key]
  }
  return current
}

function normalizeTypes(type: unknown): string[] {
  const list = Array.isArray(type) ? type : typeof type === 'string' ? [type] : []
  return list
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.toLowerCase())
    .filter((t) => KNOWN_TYPES.has(t))
}

/** Fold `allOf` branches (and the node's own keywords) into one schema. */
function mergeAllOf(node: Json, ctx: Ctx): Json {
  const { allOf, ...own } = node
  const merged: Json = {}
  const parts: unknown[] = [...(Array.isArray(allOf) ? allOf : []), own]
  for (const raw of parts) {
    let part = raw
    if (isObject(part) && typeof part.$ref === 'string') {
      const target = resolvePointer(ctx.root, part.$ref)
      const { $ref: _ref, ...siblings } = part
      part = isObject(target) ? { ...target, ...siblings } : siblings
    }
    if (!isObject(part)) continue
    for (const [key, value] of Object.entries(part)) {
      if (key === 'properties' && isObject(value)) {
        merged.properties = { ...(isObject(merged.properties) ? merged.properties : {}), ...value }
      } else if (key === 'required' && Array.isArray(value)) {
        const prior = Array.isArray(merged.required) ? merged.required : []
        merged.required = [...new Set([...prior, ...value])]
      } else if (key === 'allOf') {
        // A nested allOf is resolved when the merged node is converted.
        const prior = Array.isArray(merged.allOf) ? merged.allOf : []
        merged.allOf = [...prior, ...(Array.isArray(value) ? value : [])]
      } else if (merged[key] === undefined || key === 'description') {
        merged[key] = value
      }
    }
  }
  return merged
}

/** A branch that is exactly "null" (a description does not change that). */
function isNullBranch(branch: unknown): boolean {
  if (!isObject(branch)) return false
  const types = normalizeTypes(branch.type)
  return types.length === 1 && types[0] === 'null' && branch.anyOf === undefined && branch.oneOf === undefined
}

function dedupe(schemas: GeminiSchema[]): GeminiSchema[] {
  const seen = new Set<string>()
  return schemas.filter((schema) => {
    const key = JSON.stringify(schema)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Alternatives become one schema (a lone branch plus null is just nullable). */
function convertAlternatives(node: Json, branches: unknown[], ctx: Ctx, depth: number): GeminiSchema {
  let nullable = node.nullable === true
  const variants: GeminiSchema[] = []
  for (const branch of branches) {
    if (isNullBranch(branch)) {
      nullable = true
      continue
    }
    const converted = convert(branch, ctx, depth + 1)
    if (converted) variants.push(converted)
  }
  const unique = dedupe(variants)
  const description = typeof node.description === 'string' ? node.description : undefined
  if (unique.length === 0) return { type: 'string', nullable: true, ...(description ? { description } : {}) }
  if (unique.length === 1) {
    const only = unique[0]!
    return {
      ...only,
      ...(description ? { description } : {}),
      ...(nullable ? { nullable: true } : {})
    }
  }
  return { anyOf: unique, ...(nullable ? { nullable: true } : {}), ...(description ? { description } : {}) }
}

/** The type a keyword-only schema implies, since the API requires one. */
function inferType(node: Json, values: unknown[] | undefined): string {
  if (values && values.length > 0) {
    if (values.every((v) => typeof v === 'string')) return 'string'
    if (values.every((v) => typeof v === 'boolean')) return 'boolean'
    if (values.every((v) => typeof v === 'number')) return values.every((v) => Number.isInteger(v)) ? 'integer' : 'number'
    return 'string'
  }
  if (isObject(node.properties)) return 'object'
  if (node.items !== undefined || node.prefixItems !== undefined) return 'array'
  return 'string'
}

function describeValues(values: unknown[], isConst: boolean): string {
  if (isConst) return `Must be exactly ${JSON.stringify(values[0])}.`
  return `Allowed values: ${values.map((v) => JSON.stringify(v)).join(', ')}.`
}

function convertItems(node: Json, ctx: Ctx, depth: number): GeminiSchema {
  const raw = node.items ?? node.prefixItems
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
  const variants = dedupe(list.flatMap((item) => convert(item, ctx, depth + 1) ?? []))
  if (variants.length === 0) return { type: 'string' }
  return variants.length === 1 ? variants[0]! : { anyOf: variants }
}

function convertProperties(node: Json, ctx: Ctx, depth: number): { properties?: Record<string, GeminiSchema>; required?: string[] } {
  if (!isObject(node.properties)) return {}
  const properties: Record<string, GeminiSchema> = {}
  for (const [name, child] of Object.entries(node.properties)) {
    const converted = convert(child, ctx, depth + 1)
    if (converted) properties[name] = converted
  }
  const names = Object.keys(properties)
  if (names.length === 0) return {}
  const required = Array.isArray(node.required)
    ? node.required.filter((n): n is string => typeof n === 'string' && n in properties)
    : []
  return { properties, ...(required.length > 0 ? { required } : {}) }
}

function convert(input: unknown, ctx: Ctx, depth: number): GeminiSchema | undefined {
  if (input === false) return undefined
  // `true`, `{}` and junk all mean "anything", which the subset cannot say.
  if (!isObject(input) || depth > MAX_DEPTH) return { type: 'string' }
  let node: Json = input

  if (typeof node.$ref === 'string') {
    const ref = node.$ref
    const { $ref: _ref, ...siblings } = node
    const description = typeof siblings.description === 'string' ? siblings.description : undefined
    if (ctx.refs.includes(ref)) return { type: 'object', description: appendDescription(description, 'Recursive structure, not expanded.') }
    const target = resolvePointer(ctx.root, ref)
    if (target === false) return undefined
    const base = isObject(target) ? target : {}
    return convert({ ...base, ...siblings }, { ...ctx, refs: [...ctx.refs, ref] }, depth + 1)
  }

  if (Array.isArray(node.allOf)) node = mergeAllOf(node, ctx)

  const types = normalizeTypes(node.type)
  const branches = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : undefined
  // A declared type wins over alternatives that only add "one of these is required" rules.
  if (branches && types.length === 0) return convertAlternatives(node, branches, ctx, depth)

  let description = typeof node.description === 'string' ? node.description : undefined
  let nullable = node.nullable === true || types.includes('null')
  const nonNull = types.filter((t) => t !== 'null')

  // ["string", "number"] is a union; each member is converted on its own.
  if (nonNull.length > 1) {
    const variants = dedupe(nonNull.flatMap((t) => convert({ ...node, type: t, description: undefined }, ctx, depth + 1) ?? []))
    return { anyOf: variants, ...(nullable ? { nullable: true } : {}), ...(description ? { description } : {}) }
  }

  let values: unknown[] | undefined = 'const' in node ? [node.const] : Array.isArray(node.enum) ? node.enum : undefined
  const isConst = 'const' in node
  if (values?.includes(null)) {
    nullable = true
    values = values.filter((v) => v !== null)
  }
  if (values && values.length === 0) values = undefined

  const type = nonNull[0] ?? inferType(node, values)
  const out: GeminiSchema = { type }

  if (values) {
    if (values.every((v) => typeof v === 'string')) {
      out.type = 'string'
      out.enum = values as string[]
    } else {
      description = appendDescription(description, describeValues(values, isConst))
    }
  }

  const format = typeof node.format === 'string' ? node.format : undefined
  if (format) {
    if (FORMATS[out.type!]?.includes(format) && !out.enum) out.format = format
    else if (!out.enum) description = appendDescription(description, `Format: ${format}.`)
  }

  if (out.type === 'number' || out.type === 'integer') {
    if (finite(node.minimum)) out.minimum = node.minimum
    if (finite(node.maximum)) out.maximum = node.maximum
  } else if (out.type === 'string') {
    if (finite(node.minLength)) out.minLength = node.minLength
    if (finite(node.maxLength)) out.maxLength = node.maxLength
    if (typeof node.pattern === 'string' && !out.enum) out.pattern = node.pattern
  } else if (out.type === 'array') {
    if (finite(node.minItems)) out.minItems = node.minItems
    if (finite(node.maxItems)) out.maxItems = node.maxItems
    out.items = convertItems(node, ctx, depth)
  } else if (out.type === 'object') {
    Object.assign(out, convertProperties(node, ctx, depth))
  }

  if (nullable) out.nullable = true
  if (description) out.description = description
  return out
}

/** Sanitize one schema. Returns undefined only for the boolean schema `false`. */
export function sanitizeGeminiSchema(schema: unknown): GeminiSchema | undefined {
  const root = isObject(schema) ? schema : {}
  return convert(schema, { root, refs: [] }, 0)
}

/**
 * The `parameters` of a function declaration, or undefined for a tool that takes
 * none: the API rejects an OBJECT with empty `properties`, so it must be omitted.
 */
export function geminiFunctionParameters(inputSchema: unknown): GeminiSchema | undefined {
  const sanitized = sanitizeGeminiSchema(inputSchema)
  if (sanitized?.type !== 'object') return undefined
  return sanitized.properties && Object.keys(sanitized.properties).length > 0 ? sanitized : undefined
}
