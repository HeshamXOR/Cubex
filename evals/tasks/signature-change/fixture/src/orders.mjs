import { money } from './money.mjs'

export function ordersLine(value) {
  const shown = money(value + 0, 'USD')
  return `orders: ${shown}`
}
