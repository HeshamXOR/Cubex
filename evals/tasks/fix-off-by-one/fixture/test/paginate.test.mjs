import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageItems } from '../src/paginate.mjs'

test('pageItems slices a page', () => {
  const items = Array.from({ length: 45 }, (_, i) => i + 1)
  assert.deepEqual(pageItems(items, 1, 20).length, 20)
  assert.deepEqual(pageItems(items, 3, 20), [41, 42, 43, 44, 45])
})
