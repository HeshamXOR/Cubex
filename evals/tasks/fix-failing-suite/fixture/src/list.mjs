import { ordinal } from './text.mjs'

/** ["a", "b", "c"] -> "a, b and c". */
export function joinWords(words) {
  if (words.length === 0) return ''
  if (words.length === 1) return words[0]
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

/** A numbered ranking, one line per name: "1st Ann". */
export function ranking(names) {
  return names.map((name, i) => `${ordinal(i + 1)} ${name}`).join('\n')
}
