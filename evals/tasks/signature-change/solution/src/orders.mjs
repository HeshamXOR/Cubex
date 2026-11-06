import { money } from './money.mjs'

export function ordersLine(value) {
  const shown = money({ amount: value + 0, currency: 'USD' })
  return `orders: ${shown}`
}
