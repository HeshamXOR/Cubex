import test from 'node:test'
import assert from 'node:assert/strict'
import { money } from '../src/money.mjs'
import { depositsLine } from '../src/deposits.mjs'
import { grantsLine } from '../src/grants.mjs'
import { tipsLine } from '../src/tips.mjs'
import { feesLine } from '../src/fees.mjs'
import { creditsLine } from '../src/credits.mjs'
import { quotesLine } from '../src/quotes.mjs'
import { payoutsLine } from '../src/payouts.mjs'
import { refundsLine } from '../src/refunds.mjs'
import { invoicesLine } from '../src/invoices.mjs'
import { ordersLine } from '../src/orders.mjs'
test('orders', () => assert.equal(ordersLine(1), 'orders: USD 1.00'))
test('invoices', () => assert.equal(invoicesLine(1), 'invoices: EUR 2.00'))
test('refunds', () => assert.equal(refundsLine(1), 'refunds: GBP 3.00'))
test('payouts', () => assert.equal(payoutsLine(1), 'payouts: USD 4.00'))
test('quotes', () => assert.equal(quotesLine(1), 'quotes: EUR 5.00'))
test('credits', () => assert.equal(creditsLine(1), 'credits: GBP 6.00'))
test('fees', () => assert.equal(feesLine(1), 'fees: USD 7.00'))
test('tips', () => assert.equal(tipsLine(1), 'tips: EUR 8.00'))
test('grants', () => assert.equal(grantsLine(1), 'grants: GBP 9.00'))
test('deposits', () => assert.equal(depositsLine(1), 'deposits: USD 10.00'))
test('money takes an options object, and defaults to USD', () => {
  assert.equal(money({ amount: 2 }), 'USD 2.00')
  assert.equal(money({ amount: 2, currency: 'EUR' }), 'EUR 2.00')
})
