/** "hELLO wORLD" -> "Hello World". Words are separated by spaces. */
export function titleCase(text) {
  return text
    .split(' ')
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word))
    .join(' ')
}

/**
 * Shortens text to at most `max` characters. A text that is cut ends with "..." and the
 * three dots count toward `max`. A text that already fits is returned as it is.
 */
export function truncate(text, max) {
  if (text.length <= max) return text
  return text.slice(0, Math.max(0, max - 3)) + '...'
}

/** 1 -> "1st", 2 -> "2nd", 3 -> "3rd", 4 -> "4th", 11 -> "11th", 21 -> "21st". */
export function ordinal(n) {
  const last = n % 10
  const teens = n % 100 >= 11 && n % 100 <= 13
  if (last === 1 && !teens) return `${n}st`
  if (last === 2 && !teens) return `${n}nd`
  if (last === 3 && !teens) return `${n}rd`
  return `${n}th`
}
