/**
 * Normalizes an MCP tool's JSON Schema so strict model APIs accept it. Providers
 * differ, so this targets the common denominator: a valid object schema at the
 * root, no references (all local $ref are inlined, cycles are cut), arrays always
 * have items, formats and keywords that commonly cause HTTP 400 are folded into the
 * description instead of being sent, and size is bounded.
 */

type Json = Record<string, unknown>

export interface SanitizedSchema {
  schema: Json
  /** Human-readable notes about what was changed; for logs, never shown to the model. */
  warnings: string[]
}

const MAX_DEPTH = 24
const MAX_NODES = 4000
const MAX_PROPERTIES = 300
const MAX_VARIANTS = 24
const MAX_ENUM = 200
const MAX_DEFAULT_CHARS = 200
const MAX_SCHEMA_CHARS = 100_000
const DESCRIPTION_CAPS = [2000, 400, 100, 0]
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
/** Formats accepted by the major providers' structured-schema validators. */
const FORMATS = new Set(['date-time', 'date', 'time', 'duration', 'email', 'hostname', 'ipv4', 'ipv6', 'uuid'])

interface Context {
  root: unknown
  warnings: Set<string>
  nodes: number
  descriptionCap: number
}

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const isPrimitive = (value: unknown): value is string | number | boolean | null =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value)
const hasOwn = (target: object, key: string): boolean => Object.prototype.hasOwnProperty.call(target, key)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function warn(ctx: Context, message: string): void {
  if (ctx.warnings.size < 20) ctx.warnings.add(message)
}

function capText(text: string, cap: number): string {
  if (cap <= 0) return ''
  return text.length <= cap ? text : `${text.slice(0, Math.max(0, cap - 3))}...`
}

function resolveLocalRef(root: unknown, ref: string): unknown {
  if (ref === '#') return root
  if (!ref.startsWith('#/')) return undefined
  let current: unknown = root
  for (const part of ref.slice(2).split('/')) {
    let key: string
    try { key = decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~') } catch { return undefined }
    if (typeof current !== 'object' || current === null || !hasOwn(current, key)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function cleanType(value: unknown, nullable: boolean): string | string[] | undefined {
  const list = (Array.isArray(value) ? value : [value]).filter((t): t is string => typeof t === 'string' && TYPES.has(t))
  const unique = [...new Set(list)]
  if (nullable && unique.length > 0 && !unique.includes('null')) unique.push('null')
  if (unique.length === 0) return undefined
  return unique.length === 1 ? unique[0] : unique
}

function cleanEnum(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined
  const kept = value.filter(isPrimitive).slice(0, MAX_ENUM)
  return kept.length > 0 ? kept : undefined
}

function smallValue(value: unknown): boolean {
  try { return (JSON.stringify(value) ?? '').length <= MAX_DEFAULT_CHARS } catch { return false }
}

/** One schema covering several members: the member itself when they agree, otherwise anyOf. */
function unionOf(members: Json[]): Json {
  const unique = new Map<string, Json>()
  for (const member of members) unique.set(JSON.stringify(member), member)
  const list = [...unique.values()]
  if (list.length === 0) return {}
  return list.length === 1 ? list[0]! : { anyOf: list }
}

/** Merge `source` into `target`; keywords already on the target win. */
function mergeInto(target: Json, source: Json): void {
  for (const [key, value] of Object.entries(source)) {
    if (key === 'properties' && isRecord(value)) {
      const existing = isRecord(target.properties) ? target.properties : {}
      target.properties = { ...value, ...existing }
    } else if (key === 'required' && Array.isArray(value)) {
      const existing = Array.isArray(target.required) ? target.required : []
      target.required = [...new Set([...existing, ...value])]
    } else if (!hasOwn(target, key)) {
      target[key] = value
    }
  }
}

function cleanRef(raw: Json, stack: readonly string[], depth: number, ctx: Context): Json {
  const ref = raw.$ref as string
  const { $ref: _ignored, ...siblings } = raw
  void _ignored
  const own = cleanNode(siblings, stack, depth, ctx)
  const target = resolveLocalRef(ctx.root, ref)
  if (target === undefined) {
    warn(ctx, `Unresolvable reference "${ref.slice(0, 80)}" was replaced by an unconstrained schema.`)
    return own
  }
  if (stack.includes(ref)) {
    warn(ctx, `Cyclic reference "${ref.slice(0, 80)}" was cut.`)
    return own
  }
  return { ...cleanNode(target, [...stack, ref], depth + 1, ctx), ...own }
}

function cleanObjectPart(raw: Json, stack: readonly string[], depth: number, ctx: Context, out: Json): void {
  if (isRecord(raw.properties)) {
    const properties: Json = {}
    const hoisted: string[] = []
    let seen = 0
    for (const [key, value] of Object.entries(raw.properties)) {
      if (key === '__proto__') continue
      if (++seen > MAX_PROPERTIES) {
        warn(ctx, `More than ${MAX_PROPERTIES} properties; the rest were dropped.`)
        break
      }
      properties[key] = cleanNode(value, stack, depth + 1, ctx)
      if (isRecord(value) && value.required === true) hoisted.push(key)
    }
    out.properties = properties
    const listed = Array.isArray(raw.required) ? raw.required.filter((k): k is string => typeof k === 'string') : []
    const required = [...new Set([...listed, ...hoisted])].filter((key) => hasOwn(properties, key))
    if (required.length > 0) out.required = required
  }
  if (raw.additionalProperties === false) out.additionalProperties = false
}

function cleanArrayPart(raw: Json, stack: readonly string[], depth: number, ctx: Context, out: Json): void {
  const tuple = Array.isArray(raw.prefixItems) ? raw.prefixItems : Array.isArray(raw.items) ? raw.items : undefined
  if (tuple) out.items = unionOf(tuple.slice(0, MAX_VARIANTS).map((member) => cleanNode(member, stack, depth + 1, ctx)))
  else if (isRecord(raw.items)) out.items = cleanNode(raw.items, stack, depth + 1, ctx)
  else if (raw.items === true) out.items = {}
  for (const key of ['minItems', 'maxItems'] as const) if (count(raw[key])) out[key] = raw[key]
}

function cleanNumberPart(raw: Json, out: Json): void {
  let minimum = finite(raw.minimum) ? raw.minimum : undefined
  let maximum = finite(raw.maximum) ? raw.maximum : undefined
  let exclusiveMinimum = finite(raw.exclusiveMinimum) ? raw.exclusiveMinimum : undefined
  let exclusiveMaximum = finite(raw.exclusiveMaximum) ? raw.exclusiveMaximum : undefined
  // Draft 4 used booleans that modify minimum and maximum; later drafts use numbers.
  if (raw.exclusiveMinimum === true && minimum !== undefined) { exclusiveMinimum = minimum; minimum = undefined }
  if (raw.exclusiveMaximum === true && maximum !== undefined) { exclusiveMaximum = maximum; maximum = undefined }
  if (minimum !== undefined) out.minimum = minimum
  if (maximum !== undefined) out.maximum = maximum
  if (exclusiveMinimum !== undefined) out.exclusiveMinimum = exclusiveMinimum
  if (exclusiveMaximum !== undefined) out.exclusiveMaximum = exclusiveMaximum
  if (finite(raw.multipleOf) && raw.multipleOf > 0) out.multipleOf = raw.multipleOf
  for (const key of ['minLength', 'maxLength'] as const) if (count(raw[key])) out[key] = raw[key]
}

/** Fold anyOf/oneOf/allOf into the node: a single variant merges in, several stay as anyOf. */
function cleanCombinators(raw: Json, stack: readonly string[], depth: number, ctx: Context, out: Json): void {
  if (Array.isArray(raw.allOf)) {
    for (const member of raw.allOf.slice(0, MAX_VARIANTS)) mergeInto(out, cleanNode(member, stack, depth + 1, ctx))
  }
  const list = Array.isArray(raw.anyOf) ? raw.anyOf : Array.isArray(raw.oneOf) ? raw.oneOf : undefined
  if (!list) return
  const variants = new Map<string, Json>()
  for (const member of list.slice(0, MAX_VARIANTS)) {
    const cleaned = cleanNode(member, stack, depth + 1, ctx)
    variants.set(JSON.stringify(cleaned), cleaned)
  }
  const unique = [...variants.values()]
  if (unique.length === 1) mergeInto(out, unique[0]!)
  else if (unique.length > 1) out.anyOf = unique
}

function cleanNode(raw: unknown, stack: readonly string[], depth: number, ctx: Context): Json {
  if (!isRecord(raw)) return {}
  if (depth > MAX_DEPTH || ctx.nodes >= MAX_NODES) {
    warn(ctx, 'Schema nesting or size limit reached; deeper parts were left unconstrained.')
    return {}
  }
  ctx.nodes++
  if (typeof raw.$ref === 'string') return cleanRef(raw, stack, depth, ctx)

  const out: Json = {}
  const notes: string[] = []
  let type = cleanType(raw.type, raw.nullable === true)
  const values = cleanEnum(raw.enum) ?? (isPrimitive(raw.const) ? [raw.const] : undefined)
  if (values) out.enum = values
  if (raw.default !== undefined && smallValue(raw.default)) out.default = raw.default

  const stringLike = type === undefined || type === 'string' || (Array.isArray(type) && type.includes('string'))
  if (typeof raw.format === 'string' && raw.format) {
    if (FORMATS.has(raw.format)) out.format = raw.format
    else if (stringLike) notes.push(`format: ${raw.format}`)
  }
  if (typeof raw.pattern === 'string' && raw.pattern) notes.push(`pattern: ${raw.pattern}`)

  cleanNumberPart(raw, out)
  cleanObjectPart(raw, stack, depth, ctx, out)
  cleanArrayPart(raw, stack, depth, ctx, out)
  cleanCombinators(raw, stack, depth, ctx, out)

  if (type === undefined) {
    if (hasOwn(out, 'properties')) type = 'object'
    else if (hasOwn(out, 'items')) type = 'array'
  }
  const isArray = type === 'array' || (Array.isArray(type) && type.includes('array'))
  if (isArray && !hasOwn(out, 'items')) out.items = {}

  let description = typeof raw.description === 'string' ? capText(raw.description.trim(), ctx.descriptionCap) : ''
  if (description === '' && typeof out.description === 'string') description = out.description
  if (notes.length > 0 && ctx.descriptionCap > 0) {
    const note = notes.map((n) => `(${n})`).join(' ')
    description = description ? `${description} ${note}` : note
  }
  description = capText(description, ctx.descriptionCap)

  const result: Json = {}
  if (type !== undefined) result.type = type
  else if (typeof out.type === 'string') result.type = out.type
  if (description) result.description = description
  for (const [key, value] of Object.entries(out)) if (key !== 'description' && key !== 'type') result[key] = value
  return result
}

/** Combine the variants of a root-level anyOf when every variant is an object schema. */
function flattenRootUnion(schema: Json, ctx: Context): void {
  const variants = schema.anyOf
  delete schema.anyOf
  if (!Array.isArray(variants) || variants.length === 0) return
  const objects = variants.filter((v): v is Json => isRecord(v) && (v.type === 'object' || isRecord(v.properties)))
  if (objects.length !== variants.length) {
    warn(ctx, 'A root-level union that is not made of object schemas was dropped.')
    return
  }
  const properties: Json = isRecord(schema.properties) ? { ...schema.properties } : {}
  for (const variant of objects) {
    if (!isRecord(variant.properties)) continue
    for (const [key, value] of Object.entries(variant.properties)) if (!hasOwn(properties, key)) properties[key] = value
  }
  const requiredSets = objects.map((v) => (Array.isArray(v.required) ? (v.required as string[]) : []))
  const shared = requiredSets.reduce((acc, set) => acc.filter((key) => set.includes(key)))
  const own = Array.isArray(schema.required) ? (schema.required as string[]) : []
  schema.properties = properties
  const required = [...new Set([...own, ...shared])].filter((key) => hasOwn(properties, key))
  if (required.length > 0) schema.required = required
  else delete schema.required
}

function finishRoot(schema: Json, ctx: Context): Json {
  const type = schema.type
  const objectLike = type === undefined || type === 'object' || (Array.isArray(type) && type.includes('object'))
  if (!objectLike) {
    warn(ctx, 'The root schema was not an object schema and was replaced by an empty one.')
    return { type: 'object', properties: {} }
  }
  if (schema.anyOf !== undefined) flattenRootUnion(schema, ctx)
  const root: Json = { type: 'object' }
  if (typeof schema.description === 'string' && schema.description) root.description = schema.description
  root.properties = isRecord(schema.properties) ? schema.properties : {}
  if (Array.isArray(schema.required) && schema.required.length > 0) root.required = schema.required
  if (schema.additionalProperties === false) root.additionalProperties = false
  return root
}

function run(input: unknown, descriptionCap: number): SanitizedSchema {
  const ctx: Context = { root: input, warnings: new Set(), nodes: 0, descriptionCap }
  const schema = finishRoot(cleanNode(input, [], 0, ctx), ctx)
  return { schema, warnings: [...ctx.warnings] }
}

export function sanitizeInputSchema(input: unknown): SanitizedSchema {
  if (!isRecord(input)) return { schema: { type: 'object', properties: {} }, warnings: [] }
  let last: SanitizedSchema | undefined
  for (const cap of DESCRIPTION_CAPS) {
    last = run(input, cap)
    if (JSON.stringify(last.schema).length <= MAX_SCHEMA_CHARS) {
      if (cap < DESCRIPTION_CAPS[0]!) last.warnings.push('The schema was large; descriptions were shortened.')
      return last
    }
  }
  // Still too large without descriptions: keep only the parameter names.
  const names = isRecord(last!.schema.properties) ? Object.keys(last!.schema.properties) : []
  const shallow: Json = { type: 'object', properties: Object.fromEntries(names.map((name) => [name, {}])) }
  if (Array.isArray(last!.schema.required)) shallow.required = last!.schema.required
  return { schema: shallow, warnings: [...last!.warnings, 'The schema was too large; parameter types were dropped.'] }
}
