const TABLE = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']
]

const STANDARD = /^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/

/**
 * Converts a whole number from 1 to 3999 to a Roman numeral in the standard subtractive form
 * (4 is IV, 9 is IX, 40 is XL, 90 is XC, 400 is CD, 900 is CM). The result is uppercase.
 *
 * @param {number} n
 * @returns {string}
 * @throws {RangeError} when n is not an integer from 1 to 3999.
 */
export function toRoman(n) {
  if (!Number.isInteger(n) || n < 1 || n > 3999) throw new RangeError(`cannot write ${n} as a Roman numeral`)
  let rest = n
  let out = ''
  for (const [value, letters] of TABLE) {
    while (rest >= value) {
      out += letters
      rest -= value
    }
  }
  return out
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
  const text = String(s).toUpperCase()
  if (text === '' || !STANDARD.test(text)) throw new SyntaxError(`not a Roman numeral: ${s}`)
  let rest = text
  let total = 0
  for (const [value, letters] of TABLE) {
    while (rest.startsWith(letters)) {
      total += value
      rest = rest.slice(letters.length)
    }
  }
  return total
}
