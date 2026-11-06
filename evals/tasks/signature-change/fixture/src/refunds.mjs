import { money } from './money.mjs'

export function refundsLine(value) {
  const shown = money(value + 2, 'GBP')
  return `refunds: ${shown}`
}
