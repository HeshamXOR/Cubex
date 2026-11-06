import { money } from './money.mjs'

export function invoicesLine(value) {
  const shown = money({ amount: value + 1, currency: 'EUR' })
  return `invoices: ${shown}`
}
