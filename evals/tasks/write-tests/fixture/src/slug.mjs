/**
 * Turns a title into a URL slug: lowercase ASCII letters and digits separated by single dashes.
 * Accents are dropped ("Crème" -> "creme"), every other run of characters becomes one dash, and dashes
 * at either end are removed. A slug is cut to `maxLength` characters (80 unless told otherwise), and the
 * cut never leaves a dash at the end.
 */
export function slugify(input, { maxLength = 80 } = {}) {
  const base = String(input)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (base.length <= maxLength) return base
  return base.slice(0, maxLength).replace(/-+$/, '')
}
