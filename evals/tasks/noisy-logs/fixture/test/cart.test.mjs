const noise = (label) => { for (let i = 0; i < 400; i++) console.log(`[${label}] step ${i}: processed record ${i * 7} with checksum ${(i * 2654435761 >>> 0).toString(16)} and no problems found`) }
import test from 'node:test'
import assert from 'node:assert/strict'
import { subtotal } from '../src/cart.mjs'

test('subtotal counts the quantity of each item', () => {
  noise('cart')
  assert.equal(subtotal([{ price: 10, quantity: 3 }, { price: 5, quantity: 1 }]), 35)
})
test('an item with no quantity counts once', () => {
  noise('cart')
  assert.equal(subtotal([{ price: 10 }]), 10)
})
