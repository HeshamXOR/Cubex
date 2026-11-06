import { money } from './money.mjs'

export function payoutsLine(value) {
  const shown = money({ amount: value + 3, currency: 'USD' })
  return `payouts: ${shown}`
}
