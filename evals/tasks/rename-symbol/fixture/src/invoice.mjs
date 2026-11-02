import { calcTotal } from './pricing.mjs'

const money = (cents) => `$${(cents / 100).toFixed(2)}`

export function invoiceText(order) {
  const rows = order.lines.map((line) => `${line.qty} x ${line.name}  ${money(line.price * line.qty)}`)
  return [`Invoice ${order.id}`, ...rows, `Total  ${money(calcTotal(order.lines))}`].join('\n')
}
