import { money } from './money.mjs'

export function grantsLine(value) {
  const shown = money({ amount: value + 8, currency: 'GBP' })
  return `grants: ${shown}`
}
