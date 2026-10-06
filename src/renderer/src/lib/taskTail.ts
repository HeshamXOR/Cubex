import type { CommandOutputArtifact, CommandOutputPage } from '../../../shared/ipc'

/** The first look at a task's output is its newest bytes, so a long-running server opens fast. */
export const TAIL_WINDOW_BYTES = 24 * 1024
/** The largest page the main process serves. */
const PAGE_BYTES = 64 * 1024
/** A poll that is still behind after this many pages jumps to the newest output instead of catching up. */
const MAX_PAGES_PER_POLL = 3
/** What is kept in memory for one task; the view shows far fewer lines than this. */
export const MAX_RAW_CHARS = 96 * 1024

export type ReadPage = (offset: number, limit: number) => Promise<CommandOutputPage>

export interface TailCursor {
  /** Where the next read starts, in bytes. */
  offset: number
  /** The newest output, as the process wrote it. */
  raw: string
  /** `raw` starts where the output starts: nothing older was skipped or dropped. */
  complete: boolean
  artifact: CommandOutputArtifact
}

function cursorFrom(page: CommandOutputPage, raw: string, complete: boolean): TailCursor {
  let kept = raw
  let whole = complete
  if (kept.length > MAX_RAW_CHARS) {
    kept = kept.slice(kept.length - MAX_RAW_CHARS)
    // The cut lands anywhere in a line; start at the next whole one.
    kept = kept.slice(kept.indexOf('\n') + 1)
    whole = false
  }
  return { offset: page.nextOffset ?? page.artifact.capturedBytes, raw: kept, complete: whole, artifact: page.artifact }
}

/** Read the last window of an output of `size` bytes. */
async function fromEnd(read: ReadPage, size: number): Promise<CommandOutputPage> {
  let start = Math.max(0, size - TAIL_WINDOW_BYTES)
  for (let attempt = 0; ; attempt++) {
    try {
      return await read(start, TAIL_WINDOW_BYTES + 4)
    } catch (error) {
      // A byte offset can land inside a multi-byte character; the next whole character starts at most 3 bytes on.
      if (attempt < 3 && error instanceof Error && /splits a UTF-8/.test(error.message)) {
        start++
        continue
      }
      throw error
    }
  }
}

/**
 * Bring a task's tail up to date: the first call reads the newest window, each later one reads what was
 * written since. The offsets are the main process's own, so a character is never split.
 */
export async function advanceTail(read: ReadPage, previous: TailCursor | undefined): Promise<TailCursor> {
  if (!previous) {
    const first = await read(0, TAIL_WINDOW_BYTES)
    if (first.nextOffset === undefined) return cursorFrom(first, first.text, true)
    const newest = await fromEnd(read, first.artifact.capturedBytes)
    return cursorFrom(newest, newest.text, false)
  }
  let raw = previous.raw
  let offset = previous.offset
  let artifact = previous.artifact
  for (let pages = 0; pages < MAX_PAGES_PER_POLL; pages++) {
    const page = await read(offset, PAGE_BYTES)
    raw += page.text
    artifact = page.artifact
    if (page.nextOffset === undefined) return cursorFrom(page, raw, previous.complete)
    offset = page.nextOffset
  }
  // Written faster than it can be read: show the newest output and say older lines are not here.
  const newest = await fromEnd(read, artifact.capturedBytes)
  return cursorFrom(newest, newest.text, false)
}
