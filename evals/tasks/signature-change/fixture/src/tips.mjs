import { money } from './money.mjs'

export function tipsLine(value) {
  const shown = money(value + 7, 'EUR')
  return `tips: ${shown}`
}
