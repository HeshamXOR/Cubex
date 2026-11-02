import { test } from 'node:test'
import assert from 'node:assert/strict'
import { caption, pageCount, pageItems } from '../src/paginate.mjs'

test('pageItems slices a page', () => {
  const items = Array.from({ length: 45 }, (_, i) => i + 1)
  assert.deepEqual(pageItems(items, 1, 20).length, 20)
  assert.deepEqual(pageItems(items, 3, 20), [41, 42, 43, 44, 45])
})

test('an exact multiple does not get an empty last page', () => {
  assert.equal(pageCount(40, 20), 2)
  assert.equal(pageCount(41, 20), 3)
})

test('the caption counts from 1', () => {
  assert.equal(caption(2, 20, 45), 'Showing 21-40 of 45')
})
