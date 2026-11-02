// Regenerates the two fixtures that are produced rather than written by hand:
//   tasks/crlf-edit            lib/stock.mjs with Windows line endings (and its reference solution)
//   tasks/large-file-edit      src/messages.mjs, a long file with look-alike entries (and its reference solution)
// They are committed; run `node evals/gen-fixtures.mjs` only when changing them.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const tasks = join(dirname(fileURLToPath(import.meta.url)), 'tasks')
const put = (rel, text) => {
  const file = join(tasks, ...rel.split('/'))
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
}

// ---- crlf-edit
const stock = (low) => [
  '// Inventory helpers.',
  "// Items look like { sku: 'A-1', qty: 12 }.",
  '',
  'export function totalUnits(items) {',
  '  let total = 0',
  '  for (const item of items) {',
  '    total += item.qty',
  '  }',
  '  return total',
  '}',
  '',
  low
    ? '/** SKUs that are running low: at or below `threshold` units on hand. */'
    : '/** SKUs that are running low: fewer units on hand than `threshold`. */',
  'export function lowStock(items, threshold) {',
  '  const low = []',
  '  for (const item of items) {',
  `    if (item.qty ${low ? '<=' : '<'} threshold) {`,
  '      low.push(item.sku)',
  '    }',
  '  }',
  '  return low.sort()',
  '}',
  '',
  '/** What to order so that every SKU below `target` is brought up to it. */',
  'export function restockPlan(items, target) {',
  '  return items',
  '    .filter((item) => item.qty < target)',
  '    .map((item) => ({ sku: item.sku, order: target - item.qty }))',
  '}',
  ''
].join('\r\n')
put('crlf-edit/fixture/lib/stock.mjs', stock(false))
put('crlf-edit/solution/lib/stock.mjs', stock(true))

// ---- large-file-edit
let seed = 20240607
const next = (n) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n }
const subjects = ['The file', 'The folder', 'Your session', 'The request', 'This account', 'The database', 'The connection', 'The upload', 'Your token', 'The server']
const problems = ['could not be found', 'is locked by another process', 'has expired', 'was rejected', 'is not available right now', 'timed out', 'is too large', 'is read-only', 'is out of date', 'was closed unexpectedly']
const advice = ['Try again in a moment.', 'Check the name and try again.', 'Sign in again to continue.', 'Contact support if this keeps happening.', 'Reload the page.', '']
const families = [['AUTH', 140], ['QUOTA', 180], ['NET', 130], ['FILE', 150], ['DB', 120], ['PERM', 120]]
const lookalike = new Map([['E_QUOTA_011', 'Quota exceeded.'], ['E_QUOTA_117', 'Quota exceeded.'], ['E_QUOTA_171', 'Quota exceeded.']])
const lines = []
for (const [family, count] of families) {
  for (let i = 1; i <= count; i++) {
    const key = `E_${family}_${String(i).padStart(3, '0')}`
    const text = lookalike.get(key) ?? `${subjects[next(subjects.length)]} ${problems[next(problems.length)]}. ${advice[next(advice.length)]}`.replace(/ \.$/, '.').trim()
    lines.push(`  ${key}: '${text.replace(/'/g, "\\'")}',`)
  }
}
const large = (replacement) => [
  '// User-facing error messages, one per error code. Keep the codes sorted by family.',
  'export const MESSAGES = {',
  ...lines.map((line) => (replacement && line.startsWith('  E_QUOTA_117:') ? `  E_QUOTA_117: '${replacement}',` : line)),
  '}',
  '',
  "/** The message for an error code, or a generic one for a code we do not know. */",
  'export function message(code) {',
  "  return MESSAGES[code] ?? 'Something went wrong.'",
  '}',
  ''
].join('\n')
put('large-file-edit/fixture/src/messages.mjs', large(null))
put('large-file-edit/solution/src/messages.mjs', large('Storage quota exceeded. Free up space or upgrade your plan.'))
console.log(`crlf-edit and large-file-edit regenerated (${lines.length + 6} lines in messages.mjs)`)
