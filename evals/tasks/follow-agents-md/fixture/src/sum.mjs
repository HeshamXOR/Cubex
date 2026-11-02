// SPDX-License-Identifier: MIT

/** Sum of a list of numbers. */
export function sum(numbers) {
  return numbers.reduce((total, n) => total + n, 0)
}
