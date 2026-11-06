export function shippingFor(amount, country) {
  if (amount >= 100) return 0
  return country === 'US' ? 10 : 15
}
