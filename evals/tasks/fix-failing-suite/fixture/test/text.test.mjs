import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ordinal, titleCase, truncate } from '../src/text.mjs'

test('titleCase capitalizes each word and lowercases the rest', () => {
  assert.equal(titleCase('hello world'), 'Hello World')
  assert.equal(titleCase('hELLO wORLD'), 'Hello World')
  assert.equal(titleCase(''), '')
})

test('truncate leaves short text alone', () => {
  assert.equal(truncate('short', 10), 'short')
  assert.equal(truncate('exactly ten', 11), 'exactly ten')
})

test('truncate never returns more than max characters', () => {
  assert.equal(truncate('a long sentence here', 10), 'a long ...')
  assert.equal(truncate('a long sentence here', 10).length, 10)
})

test('ordinal handles the simple cases', () => {
  assert.equal(ordinal(1), '1st')
  assert.equal(ordinal(22), '22nd')
  assert.equal(ordinal(4), '4th')
})

test('ordinal handles the teens', () => {
  assert.equal(ordinal(11), '11th')
  assert.equal(ordinal(12), '12th')
  assert.equal(ordinal(13), '13th')
  assert.equal(ordinal(111), '111th')
})
