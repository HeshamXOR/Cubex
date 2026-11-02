import { test } from 'node:test'
import assert from 'node:assert/strict'
import { slugify } from '../src/slug.mjs'

test('lowercases and joins words with dashes', () => {
  assert.equal(slugify('Hello World'), 'hello-world')
})

test('drops accents', () => {
  assert.equal(slugify('Crème Brûlée'), 'creme-brulee')
})

test('keeps digits', () => {
  assert.equal(slugify('Top 10 Tips for 2024'), 'top-10-tips-for-2024')
})

test('a run of other characters becomes one dash', () => {
  assert.equal(slugify('a  --  b!!!c'), 'a-b-c')
  assert.equal(slugify('one___two'), 'one-two')
})

test('no dash at either end', () => {
  assert.equal(slugify('  --Hello!-- '), 'hello')
})

test('empty and symbol-only input give an empty slug', () => {
  assert.equal(slugify(''), '')
  assert.equal(slugify('!!!'), '')
})

test('non-strings are converted', () => {
  assert.equal(slugify(2024), '2024')
})

test('long input is cut to 80 characters by default', () => {
  const slug = slugify('word '.repeat(40))
  assert.equal(slug.length, 79)
  assert.ok(slug.length <= 80)
  assert.ok(!slug.endsWith('-'))
  assert.equal(slugify('a'.repeat(120)).length, 80)
})

test('maxLength is honoured and the cut never leaves a dash at the end', () => {
  assert.equal(slugify('abc def', { maxLength: 3 }), 'abc')
  assert.equal(slugify('ab cd', { maxLength: 3 }), 'ab')
  assert.equal(slugify('abc', { maxLength: 3 }), 'abc')
  assert.equal(slugify('abcdef', { maxLength: 4 }), 'abcd')
})
