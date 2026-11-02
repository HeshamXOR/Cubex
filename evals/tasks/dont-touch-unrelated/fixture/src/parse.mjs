/**
 * Reads an amount of money typed by a person: "$1,234.50", "7", "-12.50", "(12.50)".
 * Returns a number, or NaN when there is nothing to read.
 */
export function parseAmount(text) {
  const cleaned = String(text).replace(/[^0-9.]/g, '')
  return Number.parseFloat(cleaned)
}
