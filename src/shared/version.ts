/**
 * Version numbers as releases write them: `1.4.0`, `v1.4.0`, `1.5.0-beta.2`. Pure and shared, so the settings
 * normalizer and the updater read a version the same way. Nothing here throws on text it does not understand.
 */

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** The dot-separated parts after the hyphen, numbers as numbers. Empty for a final release. */
  pre: ReadonlyArray<string | number>
}

const MAX_LENGTH = 64
const PART = '(\\d{1,9})'
const IDENTIFIER = '[0-9A-Za-z-]+'
const PATTERN = new RegExp(`^[vV]?${PART}\\.${PART}\\.${PART}(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?(?:\\+${IDENTIFIER}(?:\\.${IDENTIFIER})*)?$`)

/** A version in text, or undefined when the text is not one. A leading `v` and build metadata after `+` are accepted. */
export function parseVersion(text: unknown): ParsedVersion | undefined {
  if (typeof text !== 'string' || text.length > MAX_LENGTH) return undefined
  const match = PATTERN.exec(text.trim())
  if (!match) return undefined
  const pre = match[4] === undefined ? [] : match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre }
}

/** The version as it is shown and stored: no `v`, no build metadata. Undefined for text that is not a version. */
export function normalizeVersion(text: unknown): string | undefined {
  const parsed = parseVersion(text)
  if (!parsed) return undefined
  const core = `${parsed.major}.${parsed.minor}.${parsed.patch}`
  return parsed.pre.length ? `${core}-${parsed.pre.join('.')}` : core
}

function compareNumbers(a: number, b: number): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Semver precedence of two prerelease lists. A final release (an empty list) is above any prerelease. */
function comparePre(a: ParsedVersion['pre'], b: ParsedVersion['pre']): -1 | 0 | 1 {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const left = a[index]
    const right = b[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    if (left === right) continue
    if (typeof left === 'number' && typeof right === 'number') return compareNumbers(left, right)
    // A number is lower than text; two pieces of text compare as written.
    if (typeof left === 'number') return -1
    if (typeof right === 'number') return 1
    return left < right ? -1 : 1
  }
  return 0
}

/** -1, 0 or 1 by semver precedence, or undefined when either side is not a version. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | undefined {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return undefined
  return compareNumbers(left.major, right.major) || compareNumbers(left.minor, right.minor) || compareNumbers(left.patch, right.patch) || comparePre(left.pre, right.pre)
}

/** True only when `candidate` is strictly above `current`. Text that is not a version is never newer. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) === 1
}
