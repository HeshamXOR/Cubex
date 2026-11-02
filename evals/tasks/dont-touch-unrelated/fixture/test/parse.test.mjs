import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAmount } from '../src/parse.mjs'

test('plain and formatted amounts', () => {
  assert.equal(parseAmount('7'), 7)
  assert.equal(parseAmount('$1,234.50'), 1234.5)
})

test('nothing to read is NaN', () => {
  assert.ok(Number.isNaN(parseAmount('n/a')))
})
