// Inventory helpers.
// Items look like { sku: 'A-1', qty: 12 }.

export function totalUnits(items) {
  let total = 0
  for (const item of items) {
    total += item.qty
  }
  return total
}

/** SKUs that are running low: at or below `threshold` units on hand. */
export function lowStock(items, threshold) {
  const low = []
  for (const item of items) {
    if (item.qty <= threshold) {
      low.push(item.sku)
    }
  }
  return low.sort()
}

/** What to order so that every SKU below `target` is brought up to it. */
export function restockPlan(items, target) {
  return items
    .filter((item) => item.qty < target)
    .map((item) => ({ sku: item.sku, order: target - item.qty }))
}
