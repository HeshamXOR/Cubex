import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAmount } from '../src/parse.mjs'

test('negative amounts', () => {
  assert.equal(parseAmount('-12.50'), -12.5)
  assert.equal(parseAmount('(12.50)'), -12.5)
  assert.equal(parseAmount('-$3'), -3)
  assert.equal(parseAmount('($1,000.25)'), -1000.25)
  assert.equal(parseAmount(' -7 '), -7)
})

test('positive amounts are unchanged', () => {
  assert.equal(parseAmount('12.50'), 12.5)
  assert.equal(parseAmount('$0.99'), 0.99)
  assert.equal(parseAmount('1,000'), 1000)
})

test('nothing to read is still NaN', () => {
  assert.ok(Number.isNaN(parseAmount('')))
  assert.ok(Number.isNaN(parseAmount('abc')))
})
