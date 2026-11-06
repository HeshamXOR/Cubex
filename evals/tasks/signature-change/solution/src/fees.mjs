import { money } from './money.mjs'

export function feesLine(value) {
  const shown = money({ amount: value + 6, currency: 'USD' })
  return `fees: ${shown}`
}
