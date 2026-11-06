import { money } from './money.mjs'

export function quotesLine(value) {
  const shown = money(value + 4, 'EUR')
  return `quotes: ${shown}`
}
