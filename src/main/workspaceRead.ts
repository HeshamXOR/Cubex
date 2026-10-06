import { constants } from 'node:fs'
import { open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import {
  DIR_LISTING_MAX_ENTRIES,
  FILE_PREVIEW_BYTES,
  FILE_PREVIEW_MAX_BYTES,
  IMAGE_PREVIEW_MAX_BYTES,
  STAT_PATHS_MAX,
  countLines,
  detectLineEnding,
  fileNameOf,
  type ReadFileOptions,
  type WorkspaceBrowseOptions,
  type WorkspaceFileResult,
  type WorkspaceListing,
  type WorkspacePathStat
} from '@shared/workspaceFile'
import type { DirEntry } from '@shared/ipc'
import { readWorkspaceDirectory, resolveWorkspacePath, searchWorkspaceEntries } from './workspaceFiles'

/** The bytes inspected to tell text from a binary file. */
const SNIFF_BYTES = 8 * 1024
const MIN_READ_BYTES = 1024
const MAX_PATH_CHARS = 1024

/** An error whose message is already written for the person using the app. */
class FileProblem extends Error {}

/** Normalize renderer-supplied read options: anything out of range falls back to the default. */
export function parseReadOptions(value: unknown): ReadFileOptions {
  const requested = value && typeof value === 'object' ? (value as { maxBytes?: unknown }).maxBytes : undefined
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return {}
  return { maxBytes: Math.min(FILE_PREVIEW_MAX_BYTES, Math.max(MIN_READ_BYTES, Math.floor(requested))) }
}

export function parseBrowseOptions(value: unknown): WorkspaceBrowseOptions {
  return { showHidden: !!value && typeof value === 'object' && (value as { showHidden?: unknown }).showHidden === true }
}

const posix = (path: string): string => path.split(sep).join('/')

const shortened = (path: string): string => (path.length > 80 ? `${path.slice(0, 77)}...` : path)

/** Raw fs errors carry absolute paths and codes; the person gets a sentence about the file they asked for. */
function describeFailure(error: unknown, shown: string): Error {
  if (error instanceof FileProblem) return error
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return new FileProblem(`${shown} was not found in the workspace. It may have been moved or deleted.`)
  if (code === 'EACCES' || code === 'EPERM') return new FileProblem(`Cubex is not allowed to read ${shown}.`)
  if (code === 'EBUSY') return new FileProblem(`${shown} is locked by another program. Close it there and try again.`)
  if (error instanceof Error && /escapes the workspace|Invalid workspace path|No workspace|workspace must be a folder|Invalid task id|Task was not found/.test(error.message)) return error
  return new FileProblem(`${shown} could not be read.`)
}

/** Fill `buffer` from `position`, tolerating short reads; returns how many bytes the file had. */
async function readFully(handle: FileHandle, buffer: Buffer, position: number): Promise<number> {
  let total = 0
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, position + total)
    if (bytesRead === 0) break
    total += bytesRead
  }
  return total
}

/** Images are recognised by their first bytes; the two weakest signatures also need the extension to agree. */
function sniffImage(head: Buffer, name: string): string | undefined {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  const startsWith = (...bytes: number[]): boolean => bytes.every((byte, index) => head[index] === byte)
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (startsWith(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (startsWith(0x47, 0x49, 0x46, 0x38) && (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61) return 'image/gif'
  if (startsWith(0x52, 0x49, 0x46, 0x46) && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (head.subarray(4, 11).toString('latin1') === 'ftypavi') return 'image/avif'
  if (startsWith(0x42, 0x4d) && ext === 'bmp') return 'image/bmp'
  if (startsWith(0x00, 0x00, 0x01, 0x00) && (ext === 'ico' || ext === 'cur')) return 'image/x-icon'
  return undefined
}

type Encoding = 'utf-8' | 'utf-16le' | 'utf-16be'

function detectEncoding(head: Buffer): { encoding: Encoding; bomBytes: number } {
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return { encoding: 'utf-8', bomBytes: 3 }
  if (head[0] === 0xff && head[1] === 0xfe) return { encoding: 'utf-16le', bomBytes: 2 }
  if (head[0] === 0xfe && head[1] === 0xff) return { encoding: 'utf-16be', bomBytes: 2 }
  return { encoding: 'utf-8', bomBytes: 0 }
}

/** NUL bytes, or many control characters, mean the file is not text. ESC stays allowed for saved terminal output. */
function looksBinary(head: Buffer): boolean {
  const length = Math.min(head.length, SNIFF_BYTES)
  let control = 0
  for (let i = 0; i < length; i++) {
    const byte = head[i]!
    if (byte === 0) return true
    if (byte < 9 || (byte > 13 && byte < 27) || (byte > 27 && byte < 32)) control++
  }
  return length > 0 && control / length > 0.1
}

/** Drop a UTF-8 character that the byte limit cut in half. */
function trimPartialUtf8(chunk: Buffer): Buffer {
  for (let back = 1; back <= Math.min(3, chunk.length); back++) {
    const byte = chunk[chunk.length - back]!
    if ((byte & 0xc0) === 0x80) continue
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
    return needed > back ? chunk.subarray(0, chunk.length - back) : chunk
  }
  return chunk
}

/** A cut file ends at its last line break when that keeps most of what was read, so no line is shown half. */
function endAtLineBreak(chunk: Buffer): Buffer {
  const lastBreak = chunk.lastIndexOf(0x0a)
  return lastBreak >= chunk.length / 2 ? chunk.subarray(0, lastBreak + 1) : trimPartialUtf8(chunk)
}

function decodeText(chunk: Buffer, encoding: Encoding): string {
  if (encoding === 'utf-8') return new TextDecoder('utf-8', { fatal: false }).decode(chunk)
  return new TextDecoder(encoding).decode(chunk.subarray(0, chunk.length - (chunk.length % 2)))
}

/**
 * Read one workspace file for the Files tab. The path must resolve inside the task's workspace
 * (symlinks and junctions that leave it are refused). Text comes back with its line endings
 * untouched and is cut at `maxBytes`; images come back as a data URL; anything else is reported
 * as binary with its size.
 */
export async function readWorkspaceFile(workspace: string | undefined, relPath: unknown, options: ReadFileOptions = {}): Promise<WorkspaceFileResult> {
  if (typeof relPath !== 'string' || !relPath.trim()) throw new FileProblem('Choose a file to open.')
  const shown = shortened(relPath)
  const maxBytes = Math.min(FILE_PREVIEW_MAX_BYTES, Math.max(MIN_READ_BYTES, options.maxBytes ?? FILE_PREVIEW_BYTES))
  let handle: FileHandle | undefined
  try {
    const real = resolveWorkspacePath(workspace, relPath)
    const path = posix(relative(resolveWorkspacePath(workspace, '.'), real))
    const name = fileNameOf(path || relPath)
    // Opening a folder fails differently on each OS, so say so before trying.
    if ((await stat(real)).isDirectory()) throw new FileProblem(`${shown} is a folder. Open a file inside it.`)
    // The resolved path is already canonical; O_NOFOLLOW stops a link swapped in since from being followed (where the OS has it).
    handle = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const info = await handle.stat()
    if (!info.isFile()) throw new FileProblem(`${shown} is not a regular file, so Cubex cannot show it.`)
    const base = { path, name, size: info.size, modifiedAt: info.mtimeMs }

    const first = Buffer.alloc(Math.min(info.size, maxBytes))
    const chunk = first.subarray(0, await readFully(handle, first, 0))

    const mime = sniffImage(chunk, name)
    if (mime) {
      if (info.size > IMAGE_PREVIEW_MAX_BYTES) return { ...base, kind: 'image', mime, dataUrl: null }
      let whole = chunk
      if (info.size > chunk.length) {
        whole = Buffer.alloc(info.size)
        whole = whole.subarray(0, await readFully(handle, whole, 0))
      }
      return { ...base, kind: 'image', mime, dataUrl: `data:${mime};base64,${whole.toString('base64')}` }
    }

    const { encoding, bomBytes } = detectEncoding(chunk)
    // UTF-16 text is full of NUL bytes by design; only its BOM says it is text.
    if (encoding === 'utf-8' && looksBinary(chunk)) return { ...base, kind: 'binary' }

    const truncated = info.size > chunk.length
    const body = chunk.subarray(bomBytes)
    const content = decodeText(truncated && encoding === 'utf-8' ? endAtLineBreak(body) : body, encoding)
    return {
      ...base,
      kind: 'text',
      content,
      truncated,
      lineCount: countLines(content),
      lineEnding: detectLineEnding(content),
      encoding,
      bom: bomBytes > 0
    }
  } catch (error) {
    throw describeFailure(error, shown)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** Does each path exist in the workspace, and what is its canonical path? Misses and escapes both come back `missing`. */
export async function statWorkspacePaths(workspace: string | undefined, paths: unknown): Promise<WorkspacePathStat[]> {
  if (!Array.isArray(paths) || paths.length > STAT_PATHS_MAX) throw new FileProblem(`Check at most ${STAT_PATHS_MAX} paths at a time.`)
  let root: string
  try {
    root = resolveWorkspacePath(workspace, '.')
  } catch {
    return paths.map(() => ({ kind: 'missing' }))
  }
  return Promise.all(paths.map(async (candidate: unknown): Promise<WorkspacePathStat> => {
    if (typeof candidate !== 'string' || !candidate.trim() || candidate.length > MAX_PATH_CHARS || candidate.includes('\0')) return { kind: 'missing' }
    try {
      // Models often print absolute paths; one inside the workspace is the same file as its relative form.
      // The real location comes first, so a short 8.3 name or different casing still lands inside the root.
      const requested = isAbsolute(candidate) ? relative(root, await realpath(candidate)) : candidate
      const real = resolveWorkspacePath(workspace, requested)
      const path = posix(relative(root, real))
      if (!path) return { kind: 'missing' }
      const info = await stat(real)
      if (info.isDirectory()) return { kind: 'directory', path }
      return info.isFile() ? { kind: 'file', path } : { kind: 'missing' }
    } catch {
      return { kind: 'missing' }
    }
  }))
}

/** One folder of the tree, capped so a huge folder cannot flood the window. */
export async function listWorkspaceDir(workspace: string | undefined, relPath: unknown, options: WorkspaceBrowseOptions = {}): Promise<WorkspaceListing> {
  if (typeof relPath !== 'string') throw new FileProblem('Invalid workspace path.')
  try {
    const entries = await readWorkspaceDirectory(workspace, relPath || '.', options)
    return entries.length > DIR_LISTING_MAX_ENTRIES
      ? { entries: entries.slice(0, DIR_LISTING_MAX_ENTRIES), omitted: entries.length - DIR_LISTING_MAX_ENTRIES }
      : { entries, omitted: 0 }
  } catch (error) {
    throw describeFailure(error, shortened(relPath || 'The workspace'))
  }
}

export async function findWorkspaceFiles(workspace: string | undefined, query: unknown, limit: unknown, options: WorkspaceBrowseOptions = {}): Promise<DirEntry[]> {
  if (typeof query !== 'string') throw new FileProblem('Invalid workspace search query.')
  if (limit !== undefined && typeof limit !== 'number') throw new FileProblem('Search limit must be a number.')
  return searchWorkspaceEntries(workspace, query, limit ?? 50, options)
}
