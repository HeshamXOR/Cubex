import { money } from './money.mjs'

export function depositsLine(value) {
  const shown = money(value + 9, 'USD')
  return `deposits: ${shown}`
}
