import { calcTotal, calcTotalWithTax } from './pricing.mjs'

/** Revenue of many orders, before and after tax. */
export function summarize(orders, rate = 0) {
  let net = 0
  let gross = 0
  for (const order of orders) {
    net += calcTotal(order.lines)
    gross += calcTotalWithTax(order.lines, rate)
  }
  return { orders: orders.length, net, gross }
}
