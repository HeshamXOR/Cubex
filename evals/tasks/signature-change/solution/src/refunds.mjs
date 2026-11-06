import { money } from './money.mjs'

export function refundsLine(value) {
  const shown = money({ amount: value + 2, currency: 'GBP' })
  return `refunds: ${shown}`
}
