import { promises as fs, existsSync, constants } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { resolve, relative, sep, extname, dirname } from 'node:path'
import type { ExecutableTool, JSONValue, ToolExecutionContext, ToolResult } from '@core/types'
import { lineDiff, condenseDiff, serializeDiff } from '@core/tools/lineDiff'
import { discoverFiles, type FileDiscoveryResult } from './fileDiscovery'
import { formatListing, listDirectory } from './directoryListing'
import { GitIgnore } from './gitignore'
import { MAX_REGEX_CHARACTERS, RegexTimeout, createLiteralMatcher, createRegexMatcher, type LineMatcher } from './regexSearch'
import { readFilePage } from './readFilePage'
import { FileObservations, fileVersion, withFileMutation, type FileObservation } from './fileObservations'
import { applyEdit } from './textEdit'
import { createMultiEditTool } from './multiEditTool'
import { createApplyPatchTool } from './applyPatchTool'
import type { FileMutationHost } from './fileMutationHost'
import { patchTargetPaths } from './patchFormat'
import { realpathSafe, safeResolve } from './workspacePaths'
import type { DiagnoseHook, MutatedFile } from '../diagnostics/types'

export { parseFileActivities } from './applyPatchTool'

/**
 * Workspace-scoped file tools. Every path is resolved against the workspace root
 * and rejected if it escapes it (path-traversal guard). Read/list/search are
 * `allow` by default; write/edit are `ask` so the user approves each mutation.
 */

const MAX_READ_BYTES = 256 * 1024
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'release', '.cache', '.next'])
const GLOB_SKIP_DIRS = new Set([...SKIP_DIRS, '.svn', '.hg', '.bzr', '.jj', '.sl', '.venv', '__pycache__', '.turbo', 'coverage'])
const DEFAULT_READ_LINES = 200
const MAX_READ_LINES = 2_000
const DEFAULT_GLOB_RESULTS = 100
const MAX_GLOB_RESULTS = 500
const MAX_SEARCH_FILES = 2_000
const MAX_SEARCH_BYTES = 16 * 1024 * 1024
const SEARCH_BUDGET_MS = 5_000
/** One regex gets this long on a single file (at most 256 KiB); a healthy pattern needs a few milliseconds. */
const REGEX_FILE_BUDGET_MS = 500
// Folder searches read only these; an explicit file path is searched whatever its extension.
const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.json', '.md', '.txt', '.css', '.scss', '.html', '.yml', '.yaml',
  '.toml', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.sh', '.env', '.sql', '.xml', '.svg',
  '.mjs', '.cjs', '.mts', '.cts', '.jsonc', '.mdx', '.vue', '.svelte', '.astro', '.less', '.sass', '.htm',
  '.cc', '.cxx', '.hpp', '.hh', '.cs', '.fs', '.vb', '.kt', '.kts', '.swift', '.scala', '.dart', '.rb', '.php',
  '.lua', '.pl', '.ex', '.exs', '.hs', '.clj', '.m', '.mm', '.r', '.bash', '.zsh', '.ps1', '.psm1', '.bat', '.cmd',
  '.ini', '.cfg', '.conf', '.properties', '.gradle', '.tf', '.proto', '.graphql', '.gql', '.csv', '.tsv', '.rst', '.tex'
])
const isSearchableName = (name: string): boolean => TEXT_EXT.has(extname(name).toLowerCase())

function ok(id: string, content: string): ToolResult {
  return { toolUseId: id, content }
}
function fail(id: string, content: string): ToolResult {
  return { toolUseId: id, content, isError: true }
}

/** Why a glob result is incomplete, with how many matches it left out when that is known. */
function globTruncationNotice(result: FileDiscoveryResult, limit: number): string | undefined {
  const advice = `Narrow path or pattern${result.paths.length === limit && limit < MAX_GLOB_RESULTS ? ', or increase limit' : ''}.`
  if (result.omitted) {
    // A scan that ran out of budget only knows a lower bound.
    const count = result.omittedExact ? `${result.omitted}` : `At least ${result.omitted}`
    const bound = result.omittedExact ? '' : ` (${result.truncated})`
    return `Results truncated: more than ${limit} files matched. ${count} more files matched but are not shown${bound}. ${advice}`
  }
  return result.truncated ? `Results truncated: ${result.truncated}. ${advice}` : undefined
}

/** Decode only exact UTF-8; anything else must never be round-tripped through a JS string. */
function strictUtf8(bytes: Buffer): string | undefined {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { return undefined }
}

/**
 * Replace a file's contents atomically: write a sibling temp file, fsync, then
 * rename over the real target (symlinks resolved first so a link inside the
 * workspace keeps pointing at its file). A crash leaves either the old or the
 * new bytes, never a truncated file. Falls back to an in-place write where the
 * platform refuses the rename (e.g. Windows file locked by an editor).
 */
async function atomicReplace(abs: string, data: string | Buffer): Promise<void> {
  const target = await fs.realpath(abs)
  const stat = await fs.stat(target)
  const temp = `${target}.cubex-${process.pid}-${Date.now().toString(36)}.tmp`
  const handle = await fs.open(temp, 'wx', stat.mode & 0o7777)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } catch (error) {
    // ENOSPC / antivirus locks: never leave a stray .tmp in the user's workspace.
    await handle.close().catch(() => undefined)
    await fs.rm(temp, { force: true })
    throw error
  }
  await handle.close()
  try {
    await fs.rename(temp, target)
  } catch (error) {
    await fs.rm(temp, { force: true })
    if ((error as NodeJS.ErrnoException).code !== 'EPERM' && (error as NodeJS.ErrnoException).code !== 'EACCES') throw error
    await fs.writeFile(target, data)
  }
}

export function createFileTools(
  workspaceRoot: string,
  onMutate?: (absPath: string, before: Buffer, existed: boolean, after?: Buffer | null) => void,
  diagnoseHook?: DiagnoseHook
): ExecutableTool[] {
  const root = resolve(workspaceRoot)
  const observations = new FileObservations()
  // The files the running tool call has written. Scoped to the call, not shared, so a call is checked against
  // its own changes only even if another call overlaps it.
  const toolMutations = new AsyncLocalStorage<MutatedFile[]>()
  const internalOnMutate = (absPath: string, before: Buffer, existed: boolean, after?: Buffer | null): void => {
    onMutate?.(absPath, before, existed, after)
    const written = toolMutations.getStore()
    if (written && after !== null && after !== undefined) {
      written.push({
        abs: absPath,
        before,
        existed,
        after: after.toString('utf8')
      })
    }
  }

  const observationKey = (abs: string): string => {
    // Resolve an existing ancestor for new files too; Windows short-path aliases
    // must keep the same ledger/lock key before and after the file is created.
    let ancestor = abs
    while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor)
    const canonical = resolve(realpathSafe(ancestor), relative(ancestor, abs))
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical
  }
  const requireCurrent = (key: string, version: string, full = false): FileObservation => {
    const seen = observations.get(key)
    if (!seen) throw new Error('You have not read it this turn. Call read_file on this file first.')
    if (seen.version !== version) throw new Error('File changed since you read it. Read its current contents before changing it.')
    if (full && !seen.full) throw new Error('Only part of this file was read. Read the complete file before overwriting or removing it; use edit_file for targeted changes.')
    return seen
  }
  const readForMutation = async (abs: string, signal?: AbortSignal): Promise<{ bytes: Buffer; text?: string; version: string }> => {
    signal?.throwIfAborted()
    const before = await fs.stat(abs, { bigint: true })
    if (!before.isFile()) throw new Error('A regular file is required; folders and special files are not supported.')
    if (before.size > 32 * 1024 * 1024) throw new Error('File exceeds the 32 MiB mutation limit.')
    const bytes = await fs.readFile(abs, { signal })
    const after = await fs.stat(abs, { bigint: true })
    if (fileVersion(before) !== fileVersion(after)) throw new Error('File changed while being read. Read it again before changing it.')
    signal?.throwIfAborted()
    // `text` is undefined for binary or non-UTF-8 files: snapshots keep exact bytes.
    return { bytes, text: strictUtf8(bytes), version: fileVersion(after) }
  }
  const verifyBeforeMutation = async (abs: string, version: string, signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted()
    safeResolve(root, relative(root, abs), { mutating: true })
    if (fileVersion(await fs.stat(abs, { bigint: true })) !== version) {
      throw new Error('File changed since you read it. Read its current contents before changing it.')
    }
    signal?.throwIfAborted()
  }
  const recordWritten = async (abs: string, key: string, expected: string, signal?: AbortSignal): Promise<string> => {
    try {
      const current = await readForMutation(abs, signal)
      if (!current.bytes.equals(Buffer.from(expected, 'utf8'))) throw new Error('File changed immediately after the operation. Read its current contents before changing it again.')
      return current.version
    } catch (error) {
      observations.forget(key)
      throw error
    }
  }
  const readSearchText = async (abs: string, signal?: AbortSignal): Promise<string | undefined> => {
    signal?.throwIfAborted()
    const handle = await fs.open(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = await handle.stat({ bigint: true })
      if (!opened.isFile() || opened.size > MAX_READ_BYTES) return undefined
      // Verify the opened file still corresponds to the workspace-contained path.
      // Using the handle thereafter prevents a replaced path redirecting the read.
      safeResolve(root, relative(root, abs), { listed: true })
      if (fileVersion(opened) !== fileVersion(await fs.stat(abs, { bigint: true }))) return undefined
      const buffer = Buffer.alloc(MAX_READ_BYTES + 1)
      let offset = 0
      while (offset < buffer.length) {
        signal?.throwIfAborted()
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      signal?.throwIfAborted()
      if (offset > MAX_READ_BYTES) return undefined
      const data = buffer.subarray(0, offset)
      if (data.includes(0)) throw new Error('The file contains binary data; search_files supports UTF-8 text files.')
      try { return new TextDecoder('utf-8', { fatal: true }).decode(data) }
      catch { throw new Error('The file is not valid UTF-8 text; search_files cannot search this encoding.') }
    } finally { await handle.close() }
  }

  const listFiles: ExecutableTool = {
    definition: {
      name: 'list_files',
      description:
        'List files and folders inside the workspace. Provide a relative path (default: root). ' +
        'Folders come first. Entries matched by .gitignore and dependency or VCS folders are left out, ' +
        'and very large folders are capped with a count of what is not shown. List an ignored folder directly to see inside it.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative folder path; default is the workspace root.' } }
      }
    },
    defaultPermission: 'allow',
    async execute(input: JSONValue, ctx: ToolExecutionContext): Promise<ToolResult> {
      const { path = '.' } = (input ?? {}) as { path?: string }
      try {
        const listing = await listDirectory({
          root, dir: safeResolve(root, path), ignore: new GitIgnore(root), skipNames: SKIP_DIRS, signal: ctx?.signal
        })
        return ok('', formatListing(listing))
      } catch (e) {
        if (ctx?.signal?.aborted) return fail('', 'list_files cancelled.')
        return fail('', `list_files failed: ${(e as Error).message}`)
      }
    }
  }

  const readFile: ExecutableTool = {
    definition: {
      name: 'read_file',
      description:
        'Read a UTF-8 text file inside the workspace. With only path, returns exact text up to 256 KiB. ' +
        'For large files, use offset and limit to read a bounded page with line numbers and continuation hints. ' +
        'A partial read does not permit overwriting the whole file; use edit_file for targeted edits.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path.' },
          offset: { type: 'integer', minimum: 1, description: '1-based starting line. Enables paginated reading; default 1.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_READ_LINES, description: `Lines per page; default ${DEFAULT_READ_LINES}, maximum ${MAX_READ_LINES}.` },
          line_numbers: { type: 'boolean', description: 'Include line numbers (default true for pages). Setting true alone reads the first 200 lines.' }
        },
        required: ['path']
      }
    },
    defaultPermission: 'allow',
    async execute(input: JSONValue, ctx: ToolExecutionContext): Promise<ToolResult> {
      const { path, offset, limit, line_numbers } = (input ?? {}) as {
        path?: string; offset?: number; limit?: number; line_numbers?: boolean
      }
      if (typeof path !== 'string' || !path.trim()) return fail('', 'read_file requires "path".')
      if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 1)) return fail('', 'read_file offset must be a positive integer.')
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READ_LINES)) {
        return fail('', `read_file limit must be an integer between 1 and ${MAX_READ_LINES}.`)
      }
      if (line_numbers !== undefined && typeof line_numbers !== 'boolean') return fail('', 'read_file line_numbers must be a boolean.')
      if (ctx?.signal?.aborted) return fail('', 'read_file cancelled.')
      let readKey: string | undefined
      try {
        const abs = safeResolve(root, path)
        readKey = observationKey(abs)
        const stat = await fs.stat(abs, { bigint: true })
        if (!stat.isFile()) return fail('', 'read_file requires a regular file.')
        if (offset !== undefined || limit !== undefined || line_numbers === true) {
          const start = offset ?? 1
          const page = await readFilePage(abs, start, limit ?? DEFAULT_READ_LINES, MAX_READ_BYTES - 1_024, ctx?.signal)
          const after = await fs.stat(abs, { bigint: true })
          if (fileVersion(stat) !== fileVersion(after)) return fail('', 'File changed while being read. Read the requested page again.')
          if (ctx?.signal?.aborted) return fail('', 'read_file cancelled.')
          const segments: string[] = []
          let segment: string[] = []
          for (const line of page.lines) {
            segment.push(line.text)
            if (line.truncated) { segments.push(segment.join('\n')); segment = [] }
          }
          if (segment.length) segments.push(segment.join('\n'))
          observations.record(observationKey(abs), fileVersion(after), page.fullFile, segments)
          const last = page.lines.at(-1)?.number
          const displayPath = relative(root, abs).split(sep).join('/')
          const header = last === undefined
            ? `${displayPath}: ${page.lastScannedLine === 0 && !page.hasMore ? '(empty file)' : `no lines at offset ${start}`}`
            : `${displayPath}: lines ${start}-${last}${page.hasMore ? '' : ' (end of file)'}`
          const body = page.lines.map((line) =>
            `${line_numbers === false ? '' : `${line.number}: `}${line.text}${line.truncated ? ' [line truncated after 4096 characters]' : ''}`
          )
          const footer = page.scanLimitReached
            ? `Read stopped after the 32 MiB scan budget at line ${page.lastScannedLine}. Narrow or split this large file; remaining content was not read.`
            : page.hasMore
              ? `More lines available. Continue with offset=${last === undefined ? start : last + 1}.`
              : last === undefined && page.lastScannedLine > 0 ? `End of file: ${page.lastScannedLine} lines.` : ''
          return ok('', [header, ...body, ...(footer ? ['', footer] : [])].join('\n'))
        }
        if (stat.size > MAX_READ_BYTES) {
          return fail('', `File too large (${stat.size} bytes; max ${MAX_READ_BYTES}). Use read_file with offset=1 and limit=${DEFAULT_READ_LINES} for a numbered page.`)
        }
        const text = await fs.readFile(abs, { encoding: 'utf8', signal: ctx?.signal })
        if (ctx?.signal?.aborted) return fail('', 'read_file cancelled.')
        const after = await fs.stat(abs, { bigint: true })
        if (fileVersion(stat) !== fileVersion(after)) return fail('', 'File changed while being read. Read it again.')
        observations.record(observationKey(abs), fileVersion(after), true)
        return ok('', text)
      } catch (e) {
        if (ctx?.signal?.aborted) return fail('', 'read_file cancelled.')
        if ((e as NodeJS.ErrnoException).code === 'ENOENT' && readKey) observations.forget(readKey)
        return fail('', `read_file failed: ${(e as Error).message}`)
      }
    }
  }

  const globFiles: ExecutableTool = {
    definition: {
      name: 'glob_files',
      description:
        'Discover workspace files by glob without reading their contents. Supports *, **, ?, and {a,b}; ' +
        'a pattern without / matches basenames at any depth. Returns alphabetically sorted workspace-relative paths. ' +
        'Skips symlinks, dependencies, generated folders, VCS metadata, and anything .gitignore matches (choose an ignored folder as path to search inside it). ' +
        'Search budgets and truncated results are reported, with a count of the matches not shown.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Relative glob, for example **/*.ts, src/**/*.{ts,tsx}, or package.json.' },
          path: { type: 'string', description: 'Relative folder to search under (default root). The pattern is relative to this folder.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_GLOB_RESULTS, description: `Maximum matching files; default ${DEFAULT_GLOB_RESULTS}, maximum ${MAX_GLOB_RESULTS}.` }
        },
        required: ['pattern']
      }
    },
    defaultPermission: 'allow',
    async execute(input: JSONValue, ctx: ToolExecutionContext): Promise<ToolResult> {
      const { pattern, path = '.', limit = DEFAULT_GLOB_RESULTS } = (input ?? {}) as {
        pattern?: string; path?: string; limit?: number
      }
      if (typeof pattern !== 'string' || !pattern.trim()) return fail('', 'glob_files requires "pattern".')
      if (typeof path !== 'string' || !path.trim()) return fail('', 'glob_files path must be a non-empty string.')
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_GLOB_RESULTS) {
        return fail('', `glob_files limit must be an integer between 1 and ${MAX_GLOB_RESULTS}.`)
      }
      if (ctx?.signal?.aborted) return fail('', 'glob_files cancelled.')
      try {
        const result = await discoverFiles({
          root, start: safeResolve(root, path), pattern, limit,
          skipDirectories: GLOB_SKIP_DIRS,
          validatePath: (path) => safeResolve(root, path, { listed: true }),
          signal: ctx?.signal,
          ignore: new GitIgnore(root),
          countOmitted: true
        })
        const lines = result.paths.length ? result.paths : [result.truncated ? 'No matching files in the scanned entries.' : 'No matching files.']
        const notice = globTruncationNotice(result, limit)
        if (notice) lines.push(`\n${notice}`)
        if (result.skippedDirectories) lines.push(`\nSkipped ${result.skippedDirectories} unreadable or changed directories.`)
        return ok('', lines.join('\n'))
      } catch (e) {
        if (ctx?.signal?.aborted) return fail('', 'glob_files cancelled.')
        return fail('', `glob_files failed: ${(e as Error).message}`)
      }
    }
  }

  const searchFiles: ExecutableTool = {
    definition: {
      name: 'search_files',
      description: 'Search a workspace text file or folder for a substring (case-insensitive by default) or, with regex, a JavaScript regular expression matched against each line. ' +
        'Returns path:line: text. An explicit file path searches that file only, including extensionless files and files .gitignore hides. Individual files are limited to 256 KiB. ' +
        'Skips symlinks, dependencies, generated folders, VCS metadata, and anything .gitignore matches (choose an ignored folder as path to search inside it). ' +
        'Results and scan budgets are bounded; truncation is reported. A regex that takes too long on a file stops the search and says so.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Substring to search for, or a regular expression when regex is true (at most 500 characters).' },
          path: { type: 'string', description: 'Relative file or folder to search (default: workspace root).' },
          limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum matching lines (default 100; maximum 500).' },
          regex: { type: 'boolean', description: 'Treat query as a regular expression (default false: literal substring).' },
          case_sensitive: { type: 'boolean', description: 'Match letter case exactly (default false).' }
        },
        required: ['query']
      }
    },
    defaultPermission: 'allow',
    async execute(input: JSONValue, ctx: ToolExecutionContext): Promise<ToolResult> {
      const { query, path = '.', limit = 100, regex, case_sensitive } = (input ?? {}) as {
        query?: string; path?: string; limit?: number; regex?: boolean; case_sensitive?: boolean
      }
      if (typeof query !== 'string' || !query) return fail('', 'search_files requires "query".')
      if (typeof path !== 'string' || !path.trim()) return fail('', 'search_files path must be a non-empty string.')
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) return fail('', 'search_files limit must be an integer between 1 and 500.')
      if (regex !== undefined && typeof regex !== 'boolean') return fail('', 'search_files regex must be a boolean.')
      if (case_sensitive !== undefined && typeof case_sensitive !== 'boolean') return fail('', 'search_files case_sensitive must be a boolean.')
      if (regex && query.length > MAX_REGEX_CHARACTERS) return fail('', `search_files regex pattern must be at most ${MAX_REGEX_CHARACTERS} characters.`)
      let matcher: LineMatcher
      try {
        matcher = regex ? createRegexMatcher(query, case_sensitive === true) : createLiteralMatcher(query, case_sensitive === true)
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        return fail('', `search_files failed: invalid regular expression: ${error.message.replace(/^Invalid regular expression:\s*/i, '')}`)
      }
      if (ctx?.signal?.aborted) return fail('', 'search_files cancelled.')
      try {
        const found = await discoverFiles({
          root, start: safeResolve(root, path), pattern: '**/*', limit: MAX_SEARCH_FILES,
          skipDirectories: GLOB_SKIP_DIRS, validatePath: (path) => safeResolve(root, path, { listed: true }), signal: ctx?.signal,
          allowFile: true, ignore: new GitIgnore(root), accept: isSearchableName
        })
        const hits: string[] = []
        // Only searchable files count toward the cap, so "more than N" means N text files were searched.
        let truncated = found.truncated?.startsWith('more than')
          ? `more than ${MAX_SEARCH_FILES} text files are in scope, so only the first ${MAX_SEARCH_FILES} were searched`
          : found.truncated
        let slowFile: string | undefined
        let bytes = 0
        let skipped = found.skippedDirectories
        const deadline = Date.now() + SEARCH_BUDGET_MS
        files: for (const file of found.paths) {
          ctx?.signal?.throwIfAborted()
          if (Date.now() >= deadline) { truncated = 'the content search time budget was reached'; break }
          try {
            const abs = safeResolve(root, file, { listed: true })
            // Discovery never follows symlinks. Check again before reading in
            // case an entry changed while the file list was being collected.
            const stat = await fs.lstat(abs)
            if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('The file changed during search or is not a regular file. Search the real workspace-relative path again.')
            if (stat.size > MAX_READ_BYTES) throw new Error(`File too large (${stat.size} bytes; max ${MAX_READ_BYTES}). Use read_file with offset and limit to inspect a page.`)
            if (bytes + stat.size > MAX_SEARCH_BYTES) { truncated = 'the 16 MiB content search budget was reached'; break }
            const text = await readSearchText(abs, ctx?.signal)
            if (text === undefined) throw new Error('The file changed during search or exceeded the 256 KiB limit. Inspect the file with read_file before trying again.')
            bytes += Buffer.byteLength(text, 'utf8')
            if (bytes > MAX_SEARCH_BYTES) { truncated = 'the 16 MiB content search budget was reached'; break }
            // One more than the room left, to tell "exactly limit" from "more than limit".
            let matched: number[]
            try {
              matched = matcher.matchingLines(text, limit - hits.length + 1, REGEX_FILE_BUDGET_MS)
            } catch (error) {
              if (!(error instanceof RegexTimeout)) throw error
              // Keep what matched before the expensive line; the rest of the search is abandoned.
              matched = error.partial
              slowFile = file
            }
            if (matched.length) {
              const lines = text.split('\n')
              for (const index of matched) {
                if (hits.length === limit) { truncated = `more than ${limit} lines matched`; break files }
                hits.push(`${file}:${index + 1}: ${lines[index]!.trim().slice(0, 200)}`)
              }
            }
            if (slowFile) break
          } catch (error) {
            if (ctx?.signal?.aborted) throw error
            if (found.explicitFile) throw error
            skipped++
          }
        }
        ctx?.signal?.throwIfAborted()
        const lines = hits.length ? hits : [truncated || slowFile ? `No matches for "${query}" in the scanned files.` : `No matches for "${query}".`]
        if (slowFile) {
          lines.push(`\nSearch stopped early: the regex took too long (over ${REGEX_FILE_BUDGET_MS} ms) on ${slowFile}, so the remaining files were not searched. ` +
            'Simplify the pattern (nested quantifiers such as (a+)+ are the usual cause) or narrow path.')
        }
        if (truncated) lines.push(`\nResults truncated: ${truncated}. Narrow path or query${hits.length === limit && limit < 500 ? ', or increase limit' : ''}.`)
        if (skipped) lines.push(`\nSkipped ${skipped} oversized, binary, unreadable, or changed entries.`)
        return ok('', lines.join('\n'))
      } catch (e) {
        if (ctx?.signal?.aborted) return fail('', 'search_files cancelled.')
        return fail('', `search_files failed: ${(e as Error).message}`)
      }
    }
  }

  const writeFile: ExecutableTool = {
    definition: {
      name: 'write_file',
      description: 'Create or overwrite a text file in the workspace. Requires user approval and a current full read before overwriting an existing file. Refuses stale changes.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path.' },
          content: { type: 'string', description: 'Full new file contents.' }
        },
        required: ['path', 'content']
      }
    },
    defaultPermission: 'ask',
    async execute(input: JSONValue, ctx: ToolExecutionContext): Promise<ToolResult> {
      const { path, content = '' } = (input ?? {}) as { path?: string; content?: string }
      if (typeof path !== 'string' || !path.trim()) return fail('', 'write_file requires "path".')
      if (typeof content !== 'string') return fail('', 'write_file content must be a string.')
      if (Buffer.byteLength(content, 'utf8') > 32 * 1024 * 1024) return fail('', 'write_file content exceeds the 32 MiB mutation limit.')
      // Don't mutate the workspace if the turn was cancelled before we got here.
      if (ctx?.signal?.aborted) return fail('', 'write_file cancelled.')
      try {
        const abs = safeResolve(root, path, { mutating: true })
        const key = observationKey(abs)
        const { prev, existed } = await withFileMutation(key, ctx?.signal, async () => {
          let original: { bytes: Buffer; text?: string; version: string } | undefined
          try { original = await readForMutation(abs, ctx?.signal) }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
          if (original) {
            requireCurrent(key, original.version, true)
            await verifyBeforeMutation(abs, original.version, ctx?.signal)
            await atomicReplace(abs, content)
          } else {
            if (observations.get(key)) throw new Error('File disappeared since you read it. Verify the deletion before recreating it.')
            await fs.mkdir(resolve(abs, '..'), { recursive: true })
            safeResolve(root, path, { mutating: true })
            ctx?.signal?.throwIfAborted()
            // A newly created file from another actor must never be overwritten.
            await fs.writeFile(abs, content, { encoding: 'utf8', flag: 'wx' })
          }
          internalOnMutate(abs, original?.bytes ?? Buffer.alloc(0), !!original, Buffer.from(content, 'utf8'))
          observations.record(key, await recordWritten(abs, key, content, ctx?.signal), true)

          return { prev: original ? original.text ?? '[binary or non-UTF-8 content]' : '', existed: !!original }
        })
        // Line-level diff drives both the counts and the expandable inline view.
        const full = lineDiff(prev, content)
        const added = full.filter((l) => l.tag === '+').length
        const removed = full.filter((l) => l.tag === '-').length
        const body = Buffer.from(serializeDiff(condenseDiff(full, 3).slice(0, 200)), 'utf8').toString(
          'base64'
        )
        // Stats + diff body are surfaced to the UI via the parsed markers below,
        // and stripped from the text the model sees.
        return ok(
          '',
          `Wrote ${relative(root, abs)} (${existed ? 'updated' : 'created'}). ` +
            `«diff added=${added} removed=${removed}»«diffbody:${body}»`
        )
      } catch (e) {
        if (ctx?.signal?.aborted) return fail('', 'write_file cancelled.')
        return fail('', `write_file failed: ${(e as Error).message}`)
      }
    }
  }

  const editFile: ExecutableTool = {
    definition: {
      name: 'edit_file',
      description:
        'Make a targeted edit to an EXISTING file: replace an exact `old_string` with `new_string`. ' +
        'old_string must match exactly (including whitespace/indentation) and be UNIQUE in the file unless ' +
        'replace_all is true. Read the file first; a current page read permits edits to text shown in that page. ' +
        'replace_all requires a current full read. Refuses changes made since your read. Prefer this over write_file for existing files. ' +
        'Line endings (CRLF/LF) and a UTF-8 BOM are preserved automatically, so write old_string and new_string with plain newlines. ' +
        'If old_string is not found or is ambiguous, the error shows the closest region or the matching line numbers.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path.' },
          old_string: { type: 'string', description: 'Exact text to replace (unique unless replace_all).' },
          new_string: { type: 'string', description: 'Replacement text.' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' }
        },
        required: ['path', 'old_string', 'new_string']
      }
    },
    defaultPermission: 'ask',
    async execute(input: JSONValue, ctx: ToolExecutionContext): Promise<ToolResult> {
      const { path, old_string: requestedOld, new_string: requestedNew = '', replace_all = false } = (input ?? {}) as {
        path?: string
        old_string?: string
        new_string?: string
        replace_all?: boolean
      }
      if (typeof path !== 'string' || !path.trim()) return fail('', 'edit_file requires "path".')
      if (typeof requestedOld !== 'string' || !requestedOld) return fail('', 'edit_file requires a non-empty "old_string".')
      if (typeof requestedNew !== 'string') return fail('', 'edit_file new_string must be a string.')
      if (typeof replace_all !== 'boolean') return fail('', 'edit_file replace_all must be a boolean.')
      if (ctx?.signal?.aborted) return fail('', 'edit_file cancelled.')
      try {
        const abs = safeResolve(root, path, { mutating: true })
        const key = observationKey(abs)
        const { prev, next, count } = await withFileMutation(key, ctx?.signal, async () => {
          let original: { bytes: Buffer; text?: string; version: string }
          try { original = await readForMutation(abs, ctx?.signal) }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`${relative(root, abs)} does not exist — use write_file to create it.`)
            throw error
          }
          const seen = requireCurrent(key, original.version, replace_all)
          if (original.text === undefined) {
            throw new Error('The file is binary or not valid UTF-8 (e.g. Latin-1/UTF-16). edit_file will not re-encode it, because that would corrupt every non-ASCII byte.')
          }
          // Match against an LF-normalized view and splice into the original text, so
          // CRLF/mixed endings, a BOM and the final newline survive the edit untouched.
          const edit = applyEdit(original.text, { oldString: requestedOld, newString: requestedNew, replaceAll: replace_all }, relative(root, abs))
          if (!edit.ok) throw new Error(edit.message)
          if (!seen.full && !seen.segments.some((part) => part.includes(edit.oldNormalized))) {
            throw new Error('old_string was not included in the pages you read. Read the relevant lines before editing them.')
          }
          if (Buffer.byteLength(edit.text, 'utf8') > 32 * 1024 * 1024) throw new Error('Updated file exceeds the 32 MiB mutation limit.')
          await verifyBeforeMutation(abs, original.version, ctx?.signal)
          await atomicReplace(abs, edit.text)
          internalOnMutate(abs, original.bytes, true, Buffer.from(edit.text, 'utf8'))
          observations.afterEdit(key, await recordWritten(abs, key, edit.text, ctx?.signal), seen, edit.oldNormalized, edit.newNormalized)

          return { prev: edit.before, next: edit.after, count: edit.count }
        })
        const full = lineDiff(prev, next)
        const added = full.filter((l) => l.tag === '+').length
        const removed = full.filter((l) => l.tag === '-').length
        const body = Buffer.from(serializeDiff(condenseDiff(full, 3).slice(0, 200)), 'utf8').toString('base64')
        return ok(
          '',
          `Edited ${relative(root, abs)} (${count} replacement${count === 1 ? '' : 's'}). ` +
            `«diff added=${added} removed=${removed}»«diffbody:${body}»`
        )
      } catch (e) {
        if (ctx?.signal?.aborted) return fail('', 'edit_file cancelled.')
        return fail('', `edit_file failed: ${(e as Error).message}`)
      }
    }
  }

  const removeFile: ExecutableTool = {
    definition: {
      name: 'remove_file',
      description: 'Remove one regular file from the workspace after a current full read. Requires approval. ' +
        'Never removes directories, follows symlinks, or performs recursive deletion. Refuses files changed since your read.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Relative path of the single file to remove.' } },
        required: ['path'], additionalProperties: false
      }
    },
    defaultPermission: 'ask',
    async execute(input: JSONValue, ctx: ToolExecutionContext): Promise<ToolResult> {
      const { path } = (input ?? {}) as { path?: string }
      if (typeof path !== 'string' || !path.trim()) return fail('', 'remove_file requires "path".')
      if (ctx?.signal?.aborted) return fail('', 'remove_file cancelled.')
      try {
        const abs = safeResolve(root, path, { mutating: true })
        const key = observationKey(abs)
        const prev = await withFileMutation(key, ctx?.signal, async () => {
          let ancestor = abs
          while (relative(root, ancestor) !== '') {
            if ((await fs.lstat(ancestor)).isSymbolicLink()) throw new Error('remove_file cannot follow a symbolic link.')
            ancestor = dirname(ancestor)
          }
          const stat = await fs.lstat(abs)
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('remove_file accepts one regular file only, never a directory or symbolic link.')
          const original = await readForMutation(abs, ctx?.signal)
          requireCurrent(key, original.version, true)
          await verifyBeforeMutation(abs, original.version, ctx?.signal)
          ctx?.signal?.throwIfAborted()
          await fs.unlink(abs)
          // Retain the pre-delete bytes, but record only a successful removal.
          onMutate?.(abs, original.bytes, true, null)
          observations.forget(key)
          return original.text ?? '[binary or non-UTF-8 content]'
        })
        const full = lineDiff(prev, '')
        const removed = full.filter((line) => line.tag === '-').length
        const body = Buffer.from(serializeDiff(condenseDiff(full, 3).slice(0, 200)), 'utf8').toString('base64')
        return ok('', `Removed ${relative(root, abs)}. «diff added=0 removed=${removed}»«diffbody:${body}»`)
      } catch (error) {
        if (ctx?.signal?.aborted) return fail('', 'remove_file cancelled.')
        return fail('', `remove_file failed: ${(error as Error).message}`)
      }
    }
  }

  // The multi-edit and patch tools reuse this instance's ledger, path guard and checkpoint hook.
  const host: FileMutationHost = {
    root, observations, observationKey, requireCurrent, readForMutation, verifyBeforeMutation, recordWritten, atomicReplace,
    resolvePath: (path) => safeResolve(root, path, { mutating: true }),
    onMutate: internalOnMutate
  }
  const multiEdit = createMultiEditTool(host)
  const applyPatch = createApplyPatchTool(host)

  function decorateWithDiagnostics(tool: ExecutableTool): ExecutableTool {
    if (!diagnoseHook) return tool
    const originalExecute = tool.execute.bind(tool)
    return {
      ...tool,
      async execute(input: JSONValue, ctx: ToolExecutionContext): Promise<ToolResult> {
        const written: MutatedFile[] = []
        const result = await toolMutations.run(written, () => originalExecute(input, ctx))
        if (result.isError || written.length === 0) return result
        // A checker that fails or is slow must never fail or hold back the edit that already happened.
        const report = await diagnoseHook(written, ctx?.signal).catch(() => undefined)
        if (report) {
          if (typeof result.content === 'string' && report.text) {
            result.content += report.text
          }
          result.metadata = {
            ...(result.metadata ?? {}),
            diagnostics: report.summary as unknown as JSONValue
          }
        }
        return result
      }
    }
  }

  return [
    listFiles,
    globFiles,
    readFile,
    searchFiles,
    decorateWithDiagnostics(writeFile),
    decorateWithDiagnostics(editFile),
    decorateWithDiagnostics(multiEdit),
    decorateWithDiagnostics(applyPatch),
    removeFile
  ]
}


/** Parse the «diff added=N removed=M» marker a file tool may append to its result. */
export function parseDiffMarker(text: string): { added: number; removed: number } | undefined {
  const m = /«diff added=(\d+) removed=(\d+)»/.exec(text)
  if (!m) return undefined
  return { added: Number(m[1]), removed: Number(m[2]) }
}

/** Decode the «diffbody:BASE64» marker into the serialized inline diff, if present. */
export function parseDiffBody(text: string): string | undefined {
  const m = /«diffbody:([A-Za-z0-9+/=]+)»/.exec(text)
  if (!m) return undefined
  try {
    return Buffer.from(m[1]!, 'base64').toString('utf8')
  } catch {
    return undefined
  }
}

/** Every workspace path a file-mutating tool call names: its `path`, or all the files of an apply_patch. */
export function fileMutationPaths(name: string, input: unknown): string[] {
  const args = (input ?? {}) as { path?: unknown; patch?: unknown }
  if (name === 'apply_patch') return patchTargetPaths(typeof args.patch === 'string' ? args.patch : '')
  return typeof args.path === 'string' ? [args.path] : []
}
