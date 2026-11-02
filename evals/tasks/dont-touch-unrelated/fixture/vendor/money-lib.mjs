// Vendored from upstream money-lib 1.4.2 and synced by script. Do not edit by hand: local changes are overwritten.
export function parseAmount(text) {
  const cleaned = String(text).replace(/[^0-9.]/g, '')
  return Number.parseFloat(cleaned)
}
