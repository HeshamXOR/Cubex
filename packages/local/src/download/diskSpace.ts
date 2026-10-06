import { stat } from 'node:fs/promises'
import { dirname, posix, win32 } from 'node:path'
import { DEFAULT_RESERVE_BYTES, freeDiskBytes } from './hfDownload'

const KIB = 1024

/** "4.9 GB", "19 GB", "274 MB": the same rounding the app uses wherever it shows a size. */
export function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= KIB && unit < units.length - 1) {
    value /= KIB
    unit++
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`
}

/** The closest folder that exists, since a models folder is created by its first download. */
export async function nearestExistingDir(path: string): Promise<string> {
  let current = path
  for (;;) {
    if (await stat(current).then((s) => s.isDirectory(), () => false)) return current
    const parent = dirname(current)
    if (parent === current) return current
    current = parent
  }
}

/** What a person calls the disk a folder is on: "C:" on Windows, otherwise the folder itself. */
export function volumeLabel(dir: string, platform: NodeJS.Platform = process.platform): string {
  const letter = platform === 'win32' ? /^([A-Za-z]):/.exec(win32.parse(dir).root)?.[1] : undefined
  return letter ? `${letter.toUpperCase()}:` : `the disk holding ${platform === 'win32' ? win32.normalize(dir) : posix.normalize(dir)}`
}

export interface Shortfall {
  /** The disk, as `volumeLabel` names it. */
  volume: string
  requiredBytes: number
  freeBytes: number
  reserveBytes: number
  /** How to say what is being downloaded. Default "This model". */
  subject?: string
  /** What to do about it, as a sentence. Default "Free up some space and try again." */
  advice?: string
}

/** One sentence on what a download needs and what the disk has, then what to do. */
export function shortfallMessage(s: Shortfall): string {
  const subject = s.subject ?? 'This model'
  const where = `${s.volume} has ${formatSize(s.freeBytes)} free`
  // A disk that holds the model but not the spare room reads as a contradiction unless it says so.
  const spare = s.freeBytes >= s.requiredBytes ? `, but Cubex keeps ${formatSize(s.reserveBytes)} spare so the disk does not fill up` : ''
  return `${subject} needs about ${formatSize(s.requiredBytes)} and ${where}${spare}. ${s.advice ?? 'Free up some space and try again.'}`
}

export interface SpaceCheckOptions {
  /** The folder the model will be written to; it need not exist yet. */
  dir: string
  /** Bytes still to fetch. */
  requiredBytes: number
  /** Free space to leave untouched so the disk is never filled to the last byte. Default 512 MiB. */
  reserveBytes?: number
  /** Free bytes on the volume holding a folder. Defaults to `statfs`, which reports no limit when it cannot tell. */
  freeBytes?: (dir: string) => Promise<number>
  platform?: NodeJS.Platform
  subject?: string
  advice?: string
}

export type SpaceCheck = { ok: true } | { ok: false; message: string; freeBytes: number; requiredBytes: number }

/**
 * Whether a download fits on the disk. When it does not, the message says how big
 * it is, how much room there is and what to do, in the words a person would use.
 * A disk that cannot be measured is never a reason to refuse.
 */
export async function checkFreeSpace(options: SpaceCheckOptions): Promise<SpaceCheck> {
  const reserveBytes = options.reserveBytes ?? DEFAULT_RESERVE_BYTES
  const freeOf = options.freeBytes ?? freeDiskBytes
  const dir = await nearestExistingDir(options.dir)
  const freeBytes = await freeOf(dir)
  if (!Number.isFinite(freeBytes) || freeBytes >= options.requiredBytes + reserveBytes) return { ok: true }
  return {
    ok: false,
    freeBytes,
    requiredBytes: options.requiredBytes,
    message: shortfallMessage({
      volume: volumeLabel(dir, options.platform),
      requiredBytes: options.requiredBytes,
      freeBytes,
      reserveBytes,
      ...(options.subject ? { subject: options.subject } : {}),
      ...(options.advice ? { advice: options.advice } : {})
    })
  }
}
