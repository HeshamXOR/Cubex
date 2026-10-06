import type { BigIntStats } from 'node:fs'

export function fileVersion(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
}

export interface FileObservation {
  version: string
  full: boolean
  /** Text actually shown by partial reads, with CRLF normalized for comparison. */
  segments: string[]
}

/** A turn owns its read knowledge; independent tasks/agents must not share it. */
export class FileObservations {
  private readonly files = new Map<string, FileObservation>()

  get(path: string): FileObservation | undefined { return this.files.get(path) }
  forget(path: string): void { this.files.delete(path) }

  record(path: string, version: string, full: boolean, segments: string[] = []): void {
    const prior = this.files.get(path)
    const sameVersion = prior?.version === version
    const complete = full || (sameVersion && prior.full)
    const visible = complete ? [] : [...(sameVersion ? prior.segments : []), ...segments]
    // Keep useful recent windows without letting repeated pages grow the ledger indefinitely.
    let bytes = 0
    const bounded: string[] = []
    for (let i = visible.length - 1; i >= 0; i--) {
      const segment = visible[i]!
      bytes += Buffer.byteLength(segment, 'utf8')
      if (bytes > 512 * 1024) break
      bounded.unshift(segment)
    }
    this.files.set(path, { version, full: complete, segments: bounded })
  }

  afterEdit(path: string, version: string, previous: FileObservation, oldText: string, newText: string): void {
    this.afterEdits(path, version, previous, [{ oldText, newText }])
  }

  /** Record a file's new version after several in-order replacements (multi_edit, apply_patch). */
  afterEdits(path: string, version: string, previous: FileObservation, edits: ReadonlyArray<{ oldText: string; newText: string }>): void {
    this.forget(path)
    this.record(path, version, previous.full, edits.reduce(
      (segments, edit) => replaceInSegments(segments, edit.oldText, edit.newText),
      previous.segments
    ))
  }
}

/** Page text after `oldText` was replaced by `newText`, so later edits may target the new text. */
export function replaceInSegments(segments: readonly string[], oldText: string, newText: string): string[] {
  const oldNormalized = oldText.replace(/\r\n/g, '\n')
  const newNormalized = newText.replace(/\r\n/g, '\n')
  return segments.map((part) => part.split(oldNormalized).join(newNormalized))
}

// Serialize mutations across tool closures/tasks addressing the same canonical file.
// External editors do not take this lock; version checks still run immediately before writes.
const mutationQueues = new Map<string, Promise<void>>()

export async function withFileMutation<T>(path: string, signal: AbortSignal | undefined, mutate: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(path) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const tail = previous.then(() => gate)
  mutationQueues.set(path, tail)
  try {
    await previous
    signal?.throwIfAborted()
    return await mutate()
  } finally {
    release()
    if (mutationQueues.get(path) === tail) mutationQueues.delete(path)
  }
}

/**
 * Hold the mutation lock of several files at once (a multi-file patch). Locks are taken in
 * sorted order, so two patches touching overlapping files can never wait on each other.
 */
export async function withFileMutations<T>(paths: readonly string[], signal: AbortSignal | undefined, mutate: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(paths)].sort()
  const hold = (index: number): Promise<T> =>
    index === ordered.length ? mutate() : withFileMutation(ordered[index]!, signal, () => hold(index + 1))
  return hold(0)
}
