import { money } from './money.mjs'

export function tipsLine(value) {
  const shown = money({ amount: value + 7, currency: 'EUR' })
  return `tips: ${shown}`
}
