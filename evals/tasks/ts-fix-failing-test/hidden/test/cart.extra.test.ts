import { test } from 'node:test'
import assert from 'node:assert/strict'
import { total } from '../src/cart.ts'

test('the discount is rounded to a whole cent', () => {
  const items = [{ sku: 'x', price: 333, qty: 3 }]
  assert.equal(total(items, { code: 'F', percentOff: 15, minSubtotal: 500 }), 849)
})

test('no coupon means the plain subtotal', () => {
  assert.equal(total([{ sku: 'x', price: 70, qty: 2 }]), 140)
})

test('an empty cart costs nothing, coupon or not', () => {
  assert.equal(total([], { code: 'Z', percentOff: 50, minSubtotal: 0 }), 0)
})
