// SPDX-License-Identifier: MIT

/** `value` limited to the range from `min` to `max`. */
export function clamp(value, min, max) {
  if (min > max) throw new RangeError(`min (${min}) is greater than max (${max})`)
  return Math.min(Math.max(value, min), max)
}
