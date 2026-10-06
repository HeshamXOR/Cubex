import { describe, it, expect } from 'vitest'
import { sanitizeInputSchema } from './schemaSanitize'

const clean = (input: unknown): Record<string, any> => sanitizeInputSchema(input).schema as Record<string, any>

describe('sanitizeInputSchema root', () => {
  it('returns an empty object schema for missing or non-object input', () => {
    for (const input of [undefined, null, 'x', 5, [], true]) {
      expect(clean(input)).toEqual({ type: 'object', properties: {} })
    }
  })

  it('adds type object and properties when they are missing', () => {
    expect(clean({ description: 'd' })).toEqual({ type: 'object', description: 'd', properties: {} })
    expect(clean({ properties: { a: { type: 'string' } } })).toEqual({ type: 'object', properties: { a: { type: 'string' } } })
  })

  it('replaces a non-object root and reports it', () => {
    const result = sanitizeInputSchema({ type: 'string' })
    expect(result.schema).toEqual({ type: 'object', properties: {} })
    expect(result.warnings.join(' ')).toMatch(/root/i)
  })

  it('strips schema metadata keywords', () => {
    const out = clean({ $schema: 'http://json-schema.org/draft-07/schema#', $id: 'x', $comment: 'c', type: 'object', properties: {} })
    expect(Object.keys(out).sort()).toEqual(['properties', 'type'])
  })

  it('does not mutate its input and is idempotent', () => {
    const input = { type: 'object', properties: { a: { $ref: '#/$defs/A' } }, $defs: { A: { type: 'string', format: 'uri' } } }
    const copy = JSON.parse(JSON.stringify(input))
    const once = clean(input)
    expect(input).toEqual(copy)
    expect(clean(once)).toEqual(once)
  })
})

describe('sanitizeInputSchema references', () => {
  it('inlines local $defs and definitions references', () => {
    const out = clean({
      type: 'object',
      properties: { a: { $ref: '#/$defs/Name' }, b: { $ref: '#/definitions/Age' } },
      $defs: { Name: { type: 'string', description: 'A name' } },
      definitions: { Age: { type: 'integer' } }
    })
    expect(out.properties).toEqual({ a: { type: 'string', description: 'A name' }, b: { type: 'integer' } })
    expect(JSON.stringify(out)).not.toMatch(/\$ref|\$defs|definitions/)
  })

  it('breaks a cyclic reference instead of looping', () => {
    const out = clean({
      type: 'object',
      properties: { root: { $ref: '#/$defs/Node' } },
      $defs: { Node: { type: 'object', properties: { value: { type: 'string' }, children: { type: 'array', items: { $ref: '#/$defs/Node' } } } } }
    })
    expect(JSON.stringify(out)).not.toContain('$ref')
    expect(out.properties.root.properties.value).toEqual({ type: 'string' })
    expect(out.properties.root.properties.children.type).toBe('array')
  })

  it('replaces a self-referencing root', () => {
    const out = clean({ type: 'object', properties: { next: { $ref: '#' } } })
    expect(JSON.stringify(out)).not.toContain('$ref')
    expect(out.type).toBe('object')
  })

  it('replaces remote and unresolvable references with an unconstrained schema', () => {
    const out = clean({ type: 'object', properties: { a: { $ref: 'https://example.com/schema.json' }, b: { $ref: '#/$defs/Missing' } } })
    expect(out.properties).toEqual({ a: {}, b: {} })
  })

  it('merges sibling keywords next to a $ref', () => {
    const out = clean({
      type: 'object',
      properties: { a: { $ref: '#/$defs/S', description: 'Override' } },
      $defs: { S: { type: 'string', description: 'Original' } }
    })
    expect(out.properties.a).toEqual({ type: 'string', description: 'Override' })
  })

  it('stays bounded on an exponentially expanding reference graph', () => {
    const defs: Record<string, unknown> = { L0: { type: 'string' } }
    for (let i = 1; i <= 40; i++) {
      defs[`L${i}`] = { type: 'object', properties: { a: { $ref: `#/$defs/L${i - 1}` }, b: { $ref: `#/$defs/L${i - 1}` } } }
    }
    const started = Date.now()
    const out = sanitizeInputSchema({ type: 'object', properties: { x: { $ref: '#/$defs/L40' } }, $defs: defs })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(JSON.stringify(out.schema).length).toBeLessThan(400_000)
  })

  it('bounds nesting depth', () => {
    let schema: Record<string, unknown> = { type: 'string' }
    for (let i = 0; i < 200; i++) schema = { type: 'object', properties: { next: schema } }
    const text = JSON.stringify(sanitizeInputSchema(schema).schema)
    expect((text.match(/"properties"/g) ?? []).length).toBeLessThan(60)
  })
})

describe('sanitizeInputSchema keywords', () => {
  it('keeps supported formats and folds unsupported ones into the description', () => {
    const out = clean({
      type: 'object',
      properties: { when: { type: 'string', format: 'date-time' }, link: { type: 'string', format: 'uri', description: 'Where' }, bare: { type: 'string', format: 'weird' } }
    })
    expect(out.properties.when).toEqual({ type: 'string', format: 'date-time' })
    expect(out.properties.link.format).toBeUndefined()
    expect(out.properties.link.description).toBe('Where (format: uri)')
    expect(out.properties.bare.description).toBe('(format: weird)')
  })

  it('keeps additionalProperties false and drops every other form at all depths', () => {
    const out = clean({
      type: 'object',
      additionalProperties: false,
      properties: {
        a: { type: 'object', additionalProperties: true, properties: {} },
        b: { type: 'object', additionalProperties: { type: 'string' } },
        c: { type: 'object', additionalProperties: false, properties: {} }
      }
    })
    expect(out.additionalProperties).toBe(false)
    expect(out.properties.a.additionalProperties).toBeUndefined()
    expect(out.properties.b.additionalProperties).toBeUndefined()
    expect(out.properties.c.additionalProperties).toBe(false)
  })

  it('gives arrays an items schema and collapses tuple forms', () => {
    const out = clean({
      type: 'object',
      properties: {
        plain: { type: 'array' },
        tuple: { type: 'array', items: [{ type: 'number' }, { type: 'number' }] },
        prefix: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }] }
      }
    })
    expect(out.properties.plain.items).toEqual({})
    expect(out.properties.tuple.items).toEqual({ type: 'number' })
    expect(out.properties.prefix.prefixItems).toBeUndefined()
    expect(out.properties.prefix.items).toEqual({ anyOf: [{ type: 'string' }, { type: 'number' }] })
  })

  it('filters required to existing properties and drops an empty list', () => {
    const out = clean({ type: 'object', properties: { a: { type: 'string' } }, required: ['a', 'ghost', 'a'] })
    expect(out.required).toEqual(['a'])
    expect(clean({ type: 'object', properties: { a: {} }, required: ['nope'] }).required).toBeUndefined()
  })

  it('hoists draft-3 style boolean required into the parent', () => {
    const out = clean({ type: 'object', properties: { a: { type: 'string', required: true }, b: { type: 'string', required: false } } })
    expect(out.required).toEqual(['a'])
    expect(out.properties.a.required).toBeUndefined()
  })

  it('converts draft-4 boolean exclusive bounds', () => {
    const out = clean({ type: 'object', properties: { n: { type: 'number', minimum: 5, exclusiveMinimum: true, maximum: 9, exclusiveMaximum: false } } })
    expect(out.properties.n).toEqual({ type: 'number', exclusiveMinimum: 5, maximum: 9 })
  })

  it('turns const into a one-value enum and keeps bounds and lengths', () => {
    const out = clean({
      type: 'object',
      properties: { k: { const: 'fixed' }, s: { type: 'string', minLength: 1, maxLength: 9 }, a: { type: 'array', items: {}, minItems: 1, maxItems: 3 } }
    })
    expect(out.properties.k).toEqual({ enum: ['fixed'] })
    expect(out.properties.s).toEqual({ type: 'string', minLength: 1, maxLength: 9 })
    expect(out.properties.a).toEqual({ type: 'array', items: {}, minItems: 1, maxItems: 3 })
  })

  it('folds a pattern into the description', () => {
    const out = clean({ type: 'object', properties: { id: { type: 'string', pattern: '^[a-z]+$' } } })
    expect(out.properties.id).toEqual({ type: 'string', description: '(pattern: ^[a-z]+$)' })
  })

  it('converts oneOf to anyOf and nullable to a null type', () => {
    const out = clean({
      type: 'object',
      properties: { v: { oneOf: [{ type: 'string' }, { type: 'number' }] }, n: { type: 'string', nullable: true } }
    })
    expect(out.properties.v).toEqual({ anyOf: [{ type: 'string' }, { type: 'number' }] })
    expect(out.properties.n).toEqual({ type: ['string', 'null'] })
  })

  it('validates type values', () => {
    const out = clean({ type: 'object', properties: { a: { type: ['string', 'string', 'bogus'] }, b: { type: 'str' }, c: { type: ['integer', 'null'] } } })
    expect(out.properties.a).toEqual({ type: 'string' })
    expect(out.properties.b).toEqual({})
    expect(out.properties.c).toEqual({ type: ['integer', 'null'] })
  })

  it('drops keywords providers reject and unknown extensions', () => {
    const out = clean({
      type: 'object',
      properties: { a: { type: 'string', title: 'T', examples: ['x'], 'x-internal': true, not: { type: 'null' }, if: {}, uniqueItems: true } }
    })
    expect(out.properties.a).toEqual({ type: 'string' })
  })

  it('keeps small defaults and drops large ones', () => {
    const out = clean({ type: 'object', properties: { a: { type: 'string', default: 'x' }, b: { type: 'string', default: 'y'.repeat(500) } } })
    expect(out.properties.a.default).toBe('x')
    expect(out.properties.b.default).toBeUndefined()
  })

  it('caps very long descriptions', () => {
    const out = clean({ type: 'object', properties: { a: { type: 'string', description: 'd'.repeat(5000) } } })
    expect(out.properties.a.description.length).toBeLessThanOrEqual(2000)
  })
})

describe('sanitizeInputSchema root composition', () => {
  it('merges a root allOf made of object schemas (typical generated schemas)', () => {
    const out = clean({
      allOf: [{ $ref: '#/$defs/Base' }, { type: 'object', properties: { extra: { type: 'integer' } }, required: ['extra'] }],
      $defs: { Base: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } }
    })
    expect(out.type).toBe('object')
    expect(out.allOf).toBeUndefined()
    expect(Object.keys(out.properties).sort()).toEqual(['extra', 'name'])
    expect([...out.required].sort()).toEqual(['extra', 'name'])
  })

  it('flattens a root anyOf of object variants: union of properties, intersection of required', () => {
    const out = clean({
      anyOf: [
        { type: 'object', properties: { id: { type: 'string' }, a: { type: 'string' } }, required: ['id', 'a'] },
        { type: 'object', properties: { id: { type: 'string' }, b: { type: 'number' } }, required: ['id', 'b'] }
      ]
    })
    expect(out.anyOf).toBeUndefined()
    expect(out.type).toBe('object')
    expect(Object.keys(out.properties).sort()).toEqual(['a', 'b', 'id'])
    expect(out.required).toEqual(['id'])
  })
})

describe('sanitizeInputSchema size limits', () => {
  it('falls back to a shallow schema that keeps parameter names when the schema is huge', () => {
    const properties: Record<string, unknown> = {}
    for (let i = 0; i < 250; i++) properties[`p${i}`] = { type: 'string', description: 'x'.repeat(1500) }
    const result = sanitizeInputSchema({ type: 'object', properties, required: ['p0'] })
    expect(JSON.stringify(result.schema).length).toBeLessThan(120_000)
    expect(result.schema.type).toBe('object')
    expect(Object.keys(result.schema.properties as object)).toContain('p249')
    expect(result.warnings.join(' ')).toMatch(/large|size|shortened/i)
  })

  it('drops properties beyond the cap and keeps required consistent', () => {
    const properties: Record<string, unknown> = {}
    for (let i = 0; i < 350; i++) properties[`p${i}`] = { type: 'string' }
    const out = clean({ type: 'object', properties, required: ['p0', 'p349'] })
    expect(Object.keys(out.properties)).toHaveLength(300)
    expect(out.required).toEqual(['p0'])
  })
})
