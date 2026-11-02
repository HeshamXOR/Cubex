/**
 * Converts a whole number from 1 to 3999 to a Roman numeral in the standard subtractive form
 * (4 is IV, 9 is IX, 40 is XL, 90 is XC, 400 is CD, 900 is CM). The result is uppercase.
 *
 * @param {number} n
 * @returns {string}
 * @throws {RangeError} when n is not an integer from 1 to 3999.
 */
export function toRoman(n) {
  throw new Error('not implemented')
}

/**
 * Converts a Roman numeral to its number. Letters may be upper or lower case.
 * Only the standard form is accepted: "IIII", "VX", "IC" and "" are not numerals.
 * That means fromRoman(toRoman(n)) is n for every n, and no other string is accepted.
 *
 * @param {string} s
 * @returns {number}
 * @throws {SyntaxError} when s is not a Roman numeral in the standard form.
 */
export function fromRoman(s) {
  throw new Error('not implemented')
}
