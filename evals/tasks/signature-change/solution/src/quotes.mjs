import { money } from './money.mjs'

export function quotesLine(value) {
  const shown = money({ amount: value + 4, currency: 'EUR' })
  return `quotes: ${shown}`
}
