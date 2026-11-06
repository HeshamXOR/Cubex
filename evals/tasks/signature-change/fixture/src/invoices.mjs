import { money } from './money.mjs'

export function invoicesLine(value) {
  const shown = money(value + 1, 'EUR')
  return `invoices: ${shown}`
}
