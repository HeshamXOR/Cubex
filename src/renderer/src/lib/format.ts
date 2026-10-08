/** Small formatting helpers shared by the sidebar, header and transcript. */

/** Last path segment; handles both separators and trailing slashes. */
export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** Split a path into its folder (with the trailing slash) and file name, for dimming the folder. */
export function splitPath(path: string): { dir: string; name: string } {
  const clean = path.replace(/\\/g, '/')
  const slash = clean.lastIndexOf('/')
  return slash < 0 ? { dir: '', name: clean } : { dir: clean.slice(0, slash + 1), name: clean.slice(slash + 1) }
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`
}

/** The sidebar's compact age: now, 2m, 3h, Tue, Sep 24. */
export function shortTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000))
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  const date = new Date(timestamp)
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: 'short' })
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}

/** 1200 becomes 1.2k, 38000 becomes 38k, 1500000 becomes 1.5M. */
export function compactTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(value < 10_000 ? 1 : 0))}k`
  return String(Math.round(value))
}

/** 1536 becomes 1.5 KB, 89484330 becomes 85 MB; nothing or zero is a dash. */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

/** Seconds as the transcript shows them: 0.8s, 6s, 1m 12s. */
export function formatSeconds(ms: number): string {
  const seconds = ms / 1000
  if (seconds < 10) return `${Number(seconds.toFixed(1))}s`
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`
}
