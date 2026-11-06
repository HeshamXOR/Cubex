import { money } from './money.mjs'

export function payoutsLine(value) {
  const shown = money(value + 3, 'USD')
  return `payouts: ${shown}`
}
