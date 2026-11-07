import assert from 'node:assert/strict'
import { test } from 'node:test'
import { discountedTotal } from '../src/price.mjs'

test('takes the discount off', () => {
  assert.equal(discountedTotal(200, 25), 150)
})
