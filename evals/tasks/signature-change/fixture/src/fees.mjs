import { money } from './money.mjs'

export function feesLine(value) {
  const shown = money(value + 6, 'USD')
  return `fees: ${shown}`
}
