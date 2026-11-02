import { promises as fs } from 'node:fs'
import { relative, resolve } from 'node:path'
import { buildReviewFile } from './reviewModel'

/**
 * What one turn changed, as a unified diff for the reviewer: each file as it was before the turn's first write to it,
 * against what is on disk now. The review panel's session scope covers the whole task and is built for the window; a
 * reviewer judging one turn needs only that turn, so the file tools' write callback feeds this as well.
 */

/** A file larger than this is named but not diffed, in either state. */
const MAX_FILE_BYTES = 1024 * 1024

interface Before {
  path: string
  /** The text before the turn; null when the file did not exist; undefined when it was binary or too large to diff. */
  text: string | null | undefined
}

function decode(bytes: Buffer): string | undefined {
  if (bytes.length > MAX_FILE_BYTES || bytes.includes(0)) return undefined
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { return undefined }
}

export class TurnDiff {
  private readonly files = new Map<string, Before>()

  /** A write is about to leave `before` behind. Only the first write to a file in the turn counts. */
  note(path: string, before: Buffer, existed: boolean): void {
    const key = process.platform === 'win32' ? path.toLowerCase() : path
    if (this.files.has(key)) return
    this.files.set(key, { path, text: existed ? decode(before) : null })
  }

  get size(): number {
    return this.files.size
  }

  /** The diff of every file the turn wrote that now differs from how it started. Empty when nothing does. */
  async render(workspace: string): Promise<string> {
    const root = resolve(workspace)
    const parts: string[] = []
    for (const { path, text: before } of this.files.values()) {
      const name = relative(root, resolve(path)).replace(/\\/g, '/')
      let bytes: Buffer | undefined
      try { bytes = await fs.readFile(path) } catch { bytes = undefined }
      const after = bytes === undefined ? null : decode(bytes)
      if (before === undefined || after === undefined) {
        parts.push(`diff --git a/${name} b/${name}\n[${name} is binary or too large to show]\n`)
        continue
      }
      if (before === after) continue
      const file = buildReviewFile(name, before, after)
      const lines = [`diff --git a/${name} b/${name}`, `--- ${before === null ? '/dev/null' : `a/${name}`}`, `+++ ${after === null ? '/dev/null' : `b/${name}`}`]
      for (const hunk of file.hunks) lines.push(hunk.header, ...hunk.lines)
      if (file.hunksOmitted) lines.push(`[${file.hunksOmitted} more hunks not shown]`)
      parts.push(`${lines.join('\n')}\n`)
    }
    return parts.join('')
  }
}
