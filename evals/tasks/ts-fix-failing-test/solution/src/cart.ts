export interface Item {
  sku: string
  /** Unit price in cents. */
  price: number
  qty: number
}

export interface Coupon {
  code: string
  /** Whole percent taken off, so 10 means 10%. */
  percentOff: number
  /** The coupon applies from this subtotal (in cents) upwards. */
  minSubtotal: number
}

export function subtotal(items: Item[]): number {
  return items.reduce((sum, item) => sum + item.price * item.qty, 0)
}

/** What the customer pays, in whole cents. */
export function total(items: Item[], coupon?: Coupon): number {
  const sub = subtotal(items)
  if (!coupon || sub < coupon.minSubtotal) return sub
  return Math.round(sub - (sub * coupon.percentOff) / 100)
}
