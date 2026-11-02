import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lowStock, restockPlan, totalUnits } from '../lib/stock.mjs'

const items = [
  { sku: 'B-2', qty: 3 },
  { sku: 'A-1', qty: 12 },
  { sku: 'C-3', qty: 0 }
]

test('totalUnits adds quantities', () => {
  assert.equal(totalUnits(items), 15)
})

test('lowStock lists skus under the threshold, sorted', () => {
  assert.deepEqual(lowStock(items, 5), ['B-2', 'C-3'])
})

test('restockPlan orders up to the target', () => {
  assert.deepEqual(restockPlan(items, 10), [{ sku: 'B-2', order: 7 }, { sku: 'C-3', order: 10 }])
})
