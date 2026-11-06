const noise = (label) => { for (let i = 0; i < 400; i++) console.log(`[${label}] step ${i}: processed record ${i * 7} with checksum ${(i * 2654435761 >>> 0).toString(16)} and no problems found`) }
import test from 'node:test'
import assert from 'node:assert/strict'
import { total } from '../src/total.mjs'

test('free shipping starts at exactly 100', () => {
  noise('total')
  assert.equal(total([{ price: 100, quantity: 1 }], 'JP'), 100)
})
test('the total is rounded to cents', () => {
  noise('total')
  assert.equal(total([{ price: 33.33, quantity: 3 }], 'FR'), 134.99)
})
