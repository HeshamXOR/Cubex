import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sum } from '../src/sum.mjs'

test('sum adds numbers', () => {
  assert.equal(sum([1, 2, 3]), 6)
  assert.equal(sum([]), 0)
})
