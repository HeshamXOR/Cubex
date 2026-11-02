/** Sum of price * qty over the lines of an order, in cents. */
export function calcTotal(lines) {
  let sum = 0
  for (const line of lines) sum += line.price * line.qty
  return sum
}

/** calcTotal plus tax at `rate` (0.2 is 20%), rounded to a whole cent. */
export function calcTotalWithTax(lines, rate) {
  const net = calcTotal(lines)
  return Math.round(net + net * rate)
}
