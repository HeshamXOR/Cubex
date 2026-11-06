import { money } from './money.mjs'

export function grantsLine(value) {
  const shown = money(value + 8, 'GBP')
  return `grants: ${shown}`
}
