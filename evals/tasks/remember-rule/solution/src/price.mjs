/** The price after a percentage discount. */
export function discountedTotal(price, percent) {
  return price - (price * percent) / 100
}
