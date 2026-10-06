/** A changed path as `git status` reports it. */
export interface StatusChange {
  word: string
  path: string
  /** The original path of a rename or copy. */
  from?: string
}

export interface ParsedStatus {
  /** Branch name, or "(detached)". */
  head?: string
  /** Full commit id of HEAD, or "(initial)" on an unborn branch. */
  oid?: string
  upstream?: string
  ahead?: number
  behind?: number
  staged: StatusChange[]
  unstaged: StatusChange[]
  untracked: string[]
  conflicts: string[]
}

const CHANGE_WORDS: Record<string, string> = {
  M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed', U: 'unmerged'
}
const changeWord = (code: string): string => CHANGE_WORDS[code] ?? `status ${code}`

/** `git status --porcelain=v2 --branch -z`: NUL-terminated records, so file names never need unquoting. */
export function parseStatus(raw: string): ParsedStatus {
  const status: ParsedStatus = { staged: [], unstaged: [], untracked: [], conflicts: [] }
  const records = raw.split('\0')
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!
    if (!record) continue
    if (record.startsWith('# ')) {
      const [key, ...rest] = record.slice(2).split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') status.oid = value
      else if (key === 'branch.head') status.head = value
      else if (key === 'branch.upstream') status.upstream = value
      else if (key === 'branch.ab') {
        const counts = /^\+(\d+) -(\d+)$/.exec(value)
        if (counts) { status.ahead = Number(counts[1]); status.behind = Number(counts[2]) }
      }
      continue
    }
    const kind = record[0]
    if (kind === '1' || kind === '2') {
      // 1: ordinary entry (8 fields before the path). 2: rename or copy (9), whose original path is the next record.
      const fields = record.split(' ')
      const path = fields.slice(kind === '1' ? 8 : 9).join(' ')
      const from = kind === '2' ? records[++index] : undefined
      const [x = '.', y = '.'] = [...(fields[1] ?? '..')]
      const entry = (code: string): StatusChange => ({ word: changeWord(code), path, ...(from ? { from } : {}) })
      if (x !== '.') status.staged.push(entry(x))
      if (y !== '.') status.unstaged.push(entry(y))
    } else if (kind === 'u') {
      status.conflicts.push(record.split(' ').slice(10).join(' '))
    } else if (kind === '?') {
      status.untracked.push(record.slice(2))
    }
  }
  return status
}
