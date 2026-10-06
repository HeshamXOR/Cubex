import { describe, expect, it } from 'vitest'
import { geminiFunctionParameters, sanitizeGeminiSchema } from './schema'

/** One row per JSON Schema construct Gemini's OpenAPI subset cannot take verbatim. */
const TABLE: Array<{ name: string; input: unknown; output: unknown }> = [
  {
    name: 'strips $schema, $id, additionalProperties and other keywords it rejects',
    input: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: 'urn:x',
      type: 'object',
      additionalProperties: false,
      properties: { path: { type: 'string', title: 'Path', examples: ['a'], default: 'x', $comment: 'c' } },
      required: ['path']
    },
    output: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  {
    name: 'keeps descriptions and the numeric and length constraints the subset defines',
    input: {
      type: 'object',
      properties: {
        n: { type: 'integer', description: 'Count', minimum: 1, maximum: 9, exclusiveMinimum: 0, multipleOf: 1 },
        s: { type: 'string', minLength: 1, maxLength: 4, pattern: '^a' },
        a: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3, uniqueItems: true }
      }
    },
    output: {
      type: 'object',
      properties: {
        n: { type: 'integer', description: 'Count', minimum: 1, maximum: 9 },
        s: { type: 'string', minLength: 1, maxLength: 4, pattern: '^a' },
        a: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 }
      }
    }
  },
  {
    name: 'inlines $ref to $defs and drops the definitions',
    input: {
      type: 'object',
      properties: { pos: { $ref: '#/$defs/Pos' }, list: { type: 'array', items: { $ref: '#/$defs/Pos' } } },
      $defs: { Pos: { type: 'object', properties: { line: { type: 'integer' } }, required: ['line'] } }
    },
    output: {
      type: 'object',
      properties: {
        pos: { type: 'object', properties: { line: { type: 'integer' } }, required: ['line'] },
        list: { type: 'array', items: { type: 'object', properties: { line: { type: 'integer' } }, required: ['line'] } }
      }
    }
  },
  {
    name: 'inlines $ref to definitions and keeps sibling descriptions',
    input: {
      type: 'object',
      properties: { mode: { $ref: '#/definitions/Mode', description: 'How to run' } },
      definitions: { Mode: { type: 'string', enum: ['fast', 'slow'] } }
    },
    output: { type: 'object', properties: { mode: { type: 'string', enum: ['fast', 'slow'], description: 'How to run' } } }
  },
  {
    name: 'cuts a recursive $ref instead of looping',
    input: {
      type: 'object',
      properties: { tree: { $ref: '#/$defs/Node' } },
      $defs: { Node: { type: 'object', properties: { value: { type: 'string' }, next: { $ref: '#/$defs/Node' } } } }
    },
    output: {
      type: 'object',
      properties: {
        tree: {
          type: 'object',
          properties: {
            value: { type: 'string' },
            next: { type: 'object', description: 'Recursive structure, not expanded.' }
          }
        }
      }
    }
  },
  {
    name: 'turns a string const into a one-value enum',
    input: { type: 'object', properties: { kind: { const: 'file' } } },
    output: { type: 'object', properties: { kind: { type: 'string', enum: ['file'] } } }
  },
  {
    name: 'turns a non-string const into a typed value with the constraint in words',
    input: { type: 'object', properties: { version: { const: 2, description: 'Schema version' }, on: { const: true } } },
    output: {
      type: 'object',
      properties: {
        version: { type: 'integer', description: 'Schema version. Must be exactly 2.' },
        on: { type: 'boolean', description: 'Must be exactly true.' }
      }
    }
  },
  {
    name: 'keeps an all-string enum',
    input: { type: 'object', properties: { level: { type: 'string', enum: ['a', 'b'] } } },
    output: { type: 'object', properties: { level: { type: 'string', enum: ['a', 'b'] } } }
  },
  {
    name: 'drops a numeric enum (the subset allows string enums only) and lists the values',
    input: { type: 'object', properties: { size: { type: 'integer', enum: [1, 2, 3], description: 'Size' } } },
    output: { type: 'object', properties: { size: { type: 'integer', description: 'Size. Allowed values: 1, 2, 3.' } } }
  },
  {
    name: 'drops a mixed enum and infers nothing wrong about its type',
    input: { type: 'object', properties: { v: { enum: ['a', 1] } } },
    output: { type: 'object', properties: { v: { type: 'string', description: 'Allowed values: "a", 1.' } } }
  },
  {
    name: 'turns a type array with null into nullable',
    input: { type: 'object', properties: { note: { type: ['string', 'null'], description: 'Optional' } } },
    output: { type: 'object', properties: { note: { type: 'string', nullable: true, description: 'Optional' } } }
  },
  {
    name: 'turns an anyOf with a null branch into nullable',
    input: { type: 'object', properties: { limit: { anyOf: [{ type: 'integer' }, { type: 'null' }] } } },
    output: { type: 'object', properties: { limit: { type: 'integer', nullable: true } } }
  },
  {
    name: 'turns oneOf into anyOf and keeps real alternatives',
    input: { type: 'object', properties: { id: { oneOf: [{ type: 'string' }, { type: 'number' }], description: 'Id' } } },
    output: { type: 'object', properties: { id: { anyOf: [{ type: 'string' }, { type: 'number' }], description: 'Id' } } }
  },
  {
    name: 'handles a null enum member as nullable',
    input: { type: 'object', properties: { color: { enum: ['red', null] } } },
    output: { type: 'object', properties: { color: { type: 'string', enum: ['red'], nullable: true } } }
  },
  {
    name: 'accepts OpenAPI-style nullable input',
    input: { type: 'object', properties: { x: { type: 'string', nullable: true } } },
    output: { type: 'object', properties: { x: { type: 'string', nullable: true } } }
  },
  {
    name: 'merges allOf',
    input: {
      type: 'object',
      properties: {
        opts: { allOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, { properties: { b: { type: 'number' } }, required: ['b'] }] }
      }
    },
    output: {
      type: 'object',
      properties: {
        opts: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a', 'b'] }
      }
    }
  },
  {
    name: 'infers object and array types that were left out',
    input: { properties: { files: { items: { type: 'string' } }, cfg: { properties: { k: { type: 'string' } } } } },
    output: {
      type: 'object',
      properties: { files: { type: 'array', items: { type: 'string' } }, cfg: { type: 'object', properties: { k: { type: 'string' } } } }
    }
  },
  {
    name: 'gives an array without items a string item type (the API requires items)',
    input: { type: 'object', properties: { tags: { type: 'array' } } },
    output: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } }
  },
  {
    name: 'turns tuple items into alternatives',
    input: { type: 'object', properties: { pair: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] } } },
    output: { type: 'object', properties: { pair: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] } } } }
  },
  {
    name: 'keeps date-time but turns other string formats into a hint',
    input: { type: 'object', properties: { at: { type: 'string', format: 'date-time' }, link: { type: 'string', format: 'uri', description: 'Where' } } },
    output: {
      type: 'object',
      properties: { at: { type: 'string', format: 'date-time' }, link: { type: 'string', description: 'Where. Format: uri.' } }
    }
  },
  {
    name: 'keeps int64 and double formats',
    input: { type: 'object', properties: { big: { type: 'integer', format: 'int64' }, ratio: { type: 'number', format: 'double' }, odd: { type: 'number', format: 'decimal' } } },
    output: {
      type: 'object',
      properties: { big: { type: 'integer', format: 'int64' }, ratio: { type: 'number', format: 'double' }, odd: { type: 'number', description: 'Format: decimal.' } }
    }
  },
  {
    name: 'keeps a free-form nested object without an empty properties key',
    input: { type: 'object', properties: { env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Variables' } } },
    output: { type: 'object', properties: { env: { type: 'object', description: 'Variables' } } }
  },
  {
    name: 'turns an untyped leaf into a string rather than sending a schema without a type',
    input: { type: 'object', properties: { anything: {}, same: true } },
    output: { type: 'object', properties: { anything: { type: 'string' }, same: { type: 'string' } } }
  },
  {
    name: 'drops properties whose schema is false and prunes required to what is left',
    input: { type: 'object', properties: { a: { type: 'string' }, b: false }, required: ['a', 'b', 'ghost'] },
    output: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }
  },
  {
    name: 'ignores unresolvable external refs by treating them as untyped',
    input: { type: 'object', properties: { x: { $ref: 'https://example.com/schema.json' } } },
    output: { type: 'object', properties: { x: { type: 'string' } } }
  }
]

describe('sanitizeGeminiSchema', () => {
  it.each(TABLE)('$name', ({ input, output }) => {
    expect(sanitizeGeminiSchema(input)).toEqual(output)
  })

  it('does not mutate the schema it was given', () => {
    const input = {
      type: 'object',
      additionalProperties: false,
      properties: { a: { $ref: '#/$defs/A' } },
      $defs: { A: { type: ['string', 'null'] } }
    }
    const copy = JSON.parse(JSON.stringify(input))
    sanitizeGeminiSchema(input)
    expect(input).toEqual(copy)
  })

  it('bounds runaway nesting', () => {
    let deep: Record<string, unknown> = { type: 'string' }
    for (let i = 0; i < 60; i++) deep = { type: 'object', properties: { n: deep } }
    expect(() => sanitizeGeminiSchema(deep)).not.toThrow()
  })
})

describe('geminiFunctionParameters', () => {
  it('omits parameters for a tool that takes none (the API rejects empty properties)', () => {
    expect(geminiFunctionParameters({ type: 'object', properties: {} })).toBeUndefined()
    expect(geminiFunctionParameters({ type: 'object', additionalProperties: false })).toBeUndefined()
    expect(geminiFunctionParameters({})).toBeUndefined()
  })

  it('returns a sanitized object schema otherwise', () => {
    expect(geminiFunctionParameters({ type: 'object', properties: { q: { type: 'string' } }, required: ['q'] })).toEqual({
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q']
    })
  })
})
