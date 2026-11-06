const RATES = { DE: 0.19, FR: 0.2, US: 0.07 }

export function taxFor(amount, country) {
  return amount * RATES[country]
}
