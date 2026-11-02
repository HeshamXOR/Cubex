import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ordinal, titleCase, truncate } from '../src/text.mjs'

test('more ordinals', () => {
  const want = { 0: '0th', 3: '3rd', 10: '10th', 21: '21st', 100: '100th', 101: '101st', 112: '112th', 113: '113th', 121: '121st', 1002: '1002nd' }
  for (const [n, text] of Object.entries(want)) assert.equal(ordinal(Number(n)), text)
})

test('more truncation', () => {
  assert.equal(truncate('abcdefghij', 8), 'abcde...')
  assert.equal(truncate('abcdefghij', 10), 'abcdefghij')
  assert.equal(truncate('abcdefghij', 4), 'a...')
})

test('more title case', () => {
  assert.equal(titleCase('the QUICK  brown fox'), 'The Quick  Brown Fox')
})
