import { test } from 'node:test'
import assert from 'node:assert/strict'
import { subtotal, total, type Coupon } from '../src/cart.ts'

const items = [
  { sku: 'pen', price: 250, qty: 4 },
  { sku: 'pad', price: 500, qty: 2 }
]
const tenOff: Coupon = { code: 'TEN', percentOff: 10, minSubtotal: 2000 }

test('subtotal adds price times quantity', () => {
  assert.equal(subtotal(items), 2000)
})

test('a coupon takes its percentage off', () => {
  assert.equal(total(items, tenOff), 1800)
})

test('a coupon applies when the subtotal is exactly its minimum', () => {
  assert.equal(total([{ sku: 'pad', price: 2000, qty: 1 }], tenOff), 1800)
})

test('a coupon does not apply below its minimum', () => {
  assert.equal(total([{ sku: 'pad', price: 1999, qty: 1 }], tenOff), 1999)
})
