import { money } from './money.mjs'

export function depositsLine(value) {
  const shown = money({ amount: value + 9, currency: 'USD' })
  return `deposits: ${shown}`
}
