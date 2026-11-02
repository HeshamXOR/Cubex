// Display helpers. Old code, ugly but covered by the snapshot tests of the web app: leave the style alone.
var SYMBOLS = { USD: '$', EUR: 'EUR ', GBP: 'GBP ' }

export function formatAmount(value, currency) {
  var sign = value < 0 ? '-' : ''
  var abs = Math.abs(value)
  var fixed = abs.toFixed(2)
  if (SYMBOLS[currency] == undefined) return sign + fixed
  return sign + SYMBOLS[currency] + fixed
}
