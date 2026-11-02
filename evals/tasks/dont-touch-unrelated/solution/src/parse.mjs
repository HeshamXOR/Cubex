/**
 * Reads an amount of money typed by a person: "$1,234.50", "7", "-12.50", "(12.50)".
 * Returns a number, or NaN when there is nothing to read.
 */
export function parseAmount(text) {
  const raw = String(text).trim()
  const negative = /^\(.*\)$/.test(raw) || /^[-\u2212]/.test(raw) || /^\$?-/.test(raw)
  const cleaned = raw.replace(/[^0-9.]/g, '')
  const value = Number.parseFloat(cleaned)
  return negative ? -value : value
}
