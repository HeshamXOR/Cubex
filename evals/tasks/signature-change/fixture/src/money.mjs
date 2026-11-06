export function money(amount, currency) {
  return `${currency} ${amount.toFixed(2)}`
}
