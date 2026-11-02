import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calcTotal, calcTotalWithTax } from '../src/pricing.mjs'
import { invoiceText } from '../src/invoice.mjs'
import { summarize } from '../src/report.mjs'

const order = { id: 'A1', lines: [{ name: 'pen', price: 250, qty: 4 }, { name: 'pad', price: 500, qty: 2 }] }

test('calcTotal adds the lines', () => {
  assert.equal(calcTotal(order.lines), 2000)
  assert.equal(calcTotal([]), 0)
})

test('calcTotalWithTax adds tax', () => {
  assert.equal(calcTotalWithTax(order.lines, 0.25), 2500)
})

test('the invoice ends with the total', () => {
  assert.match(invoiceText(order), /Total {2}\$20\.00$/)
})

test('summarize totals orders', () => {
  assert.deepEqual(summarize([order, order], 0.5), { orders: 2, net: 4000, gross: 6000 })
})
