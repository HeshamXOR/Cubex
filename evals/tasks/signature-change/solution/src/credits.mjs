import { money } from './money.mjs'

export function creditsLine(value) {
  const shown = money({ amount: value + 5, currency: 'GBP' })
  return `credits: ${shown}`
}
