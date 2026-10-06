import type { DirEntry } from './ipc'

/** What the Files tab asks for by default when it opens a text file. */
export const FILE_PREVIEW_BYTES = 512 * 1024
/** The most text one read may return, however much the caller asks for. */
export const FILE_PREVIEW_MAX_BYTES = 4 * 1024 * 1024
/** Larger images are described but not sent over IPC. */
export const IMAGE_PREVIEW_MAX_BYTES = 8 * 1024 * 1024
/** Folders with more entries than this list the first ones and count the rest. */
export const DIR_LISTING_MAX_ENTRIES = 2_000
/** Paths one stat call checks. */
export const STAT_PATHS_MAX = 40

export interface ReadFileOptions {
  /** Bytes of text to return. Defaults to 512 KB and is capped at 4 MB. */
  maxBytes?: number
}

type LineEnding = 'lf' | 'crlf' | 'cr' | 'mixed' | 'none'

interface WorkspaceFileBase {
  /** Workspace-relative path with forward slashes, as the tree lists it. */
  path: string
  name: string
  /** Bytes on disk. */
  size: number
  modifiedAt: number
}

export type WorkspaceFileResult =
  | (WorkspaceFileBase & {
      kind: 'text'
      /** Line endings are kept as they are on disk; split with `splitLines`. */
      content: string
      /** True when the file is longer than what `content` holds. */
      truncated: boolean
      lineCount: number
      lineEnding: LineEnding
      encoding: 'utf-8' | 'utf-16le' | 'utf-16be'
      bom: boolean
    })
  | (WorkspaceFileBase & {
      kind: 'image'
      mime: string
      /** Null when the image is larger than the preview limit. */
      dataUrl: string | null
    })
  | (WorkspaceFileBase & { kind: 'binary' })

export type WorkspacePathStat =
  | { kind: 'file' | 'directory'; /** The canonical workspace-relative path to open. */ path: string }
  | { kind: 'missing' }

export interface WorkspaceBrowseOptions {
  /** Include dot-names and ignored folders such as node_modules. */
  showHidden?: boolean
}

export interface WorkspaceListing {
  entries: DirEntry[]
  /** Entries beyond DIR_LISTING_MAX_ENTRIES that are not listed. */
  omitted: number
}

/**
 * The lines of a text, whatever its line endings (LF, CRLF or a lone CR). A final line break
 * ends the last line instead of starting another, so "a\nb\n" has two lines and "" has none.
 */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r\n|\r|\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Same count as `splitLines(text).length`, without building the lines. */
export function countLines(text: string): number {
  if (text === '') return 0
  let breaks = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 13) {
      breaks++
      if (text.charCodeAt(i + 1) === 10) i++
    } else if (code === 10) breaks++
  }
  const last = text.charCodeAt(text.length - 1)
  return last === 10 || last === 13 ? breaks : breaks + 1
}

export function detectLineEnding(text: string): LineEnding {
  let lf = 0
  let crlf = 0
  let cr = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 13) {
      if (text.charCodeAt(i + 1) === 10) { crlf++; i++ } else cr++
    } else if (code === 10) lf++
  }
  const kinds = (lf > 0 ? 1 : 0) + (crlf > 0 ? 1 : 0) + (cr > 0 ? 1 : 0)
  if (kinds === 0) return 'none'
  if (kinds > 1) return 'mixed'
  return lf > 0 ? 'lf' : crlf > 0 ? 'crlf' : 'cr'
}

/** The last path segment, for either separator. */
export function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}
