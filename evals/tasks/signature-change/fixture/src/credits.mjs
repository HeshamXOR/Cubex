import { money } from './money.mjs'

export function creditsLine(value) {
  const shown = money(value + 5, 'GBP')
  return `credits: ${shown}`
}
