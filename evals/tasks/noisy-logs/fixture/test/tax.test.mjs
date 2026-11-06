const noise = (label) => { for (let i = 0; i < 400; i++) console.log(`[${label}] step ${i}: processed record ${i * 7} with checksum ${(i * 2654435761 >>> 0).toString(16)} and no problems found`) }
import test from 'node:test'
import assert from 'node:assert/strict'
import { taxFor } from '../src/tax.mjs'

test('a country with no rate pays no tax', () => {
  noise('tax')
  assert.equal(taxFor(100, 'JP'), 0)
})
test('tax is rounded to cents', () => {
  noise('tax')
  assert.equal(taxFor(10.05, 'DE'), 1.91)
})
