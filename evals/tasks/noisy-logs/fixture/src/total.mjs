import { subtotal } from './cart.mjs'
import { shippingFor } from './shipping.mjs'
import { taxFor } from './tax.mjs'

export function total(items, country) {
  const net = subtotal(items)
  return net + taxFor(net, country) + shippingFor(net, country)
}
