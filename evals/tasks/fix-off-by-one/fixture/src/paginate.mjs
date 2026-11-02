/** Number of pages needed for `total` results at `size` per page. There is always at least one page. */
export function pageCount(total, size) {
  return Math.max(1, Math.floor(total / size) + 1)
}

/** The results on a page. Pages start at 1. */
export function pageItems(items, page, size) {
  const start = (page - 1) * size
  return items.slice(start, start + size)
}

/** The caption under the results, for example "Showing 21-40 of 45". */
export function caption(page, size, total) {
  if (total === 0) return 'No results'
  const first = (page - 1) * size
  const last = Math.min(page * size, total)
  return `Showing ${first}-${last} of ${total}`
}
