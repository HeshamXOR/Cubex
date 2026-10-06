import { existsSync, promises as fs } from 'node:fs'
import { dirname, relative, sep } from 'node:path'
import type { ExecutableTool, JSONValue, ToolExecutionContext, ToolResult } from '@core/types'
import type { ToolFileActivity } from '@shared/ipc'
import { replaceInSegments, withFileMutations, type FileObservation } from './fileObservations'
import { diffTotalsMarker, MUTATION_LIMIT_BYTES, summarizeDiff, toolFail, toolOk, type FileMutationHost } from './fileMutationHost'
import { applyChunks } from './patchApply'
import { parsePatch, type PatchOperation } from './patchFormat'
import { analyzeText } from './textEdit'

const MAX_PATCH_CHARACTERS = 4 * 1024 * 1024
const MAX_OPERATIONS = 200
const MAX_REPORTED_PROBLEMS = 5
const MAX_LISTED_FILES = 50
/** Diff lines kept across all files of one patch; later files report counts only. */
const MAX_DIFF_LINES = 2_000
const BINARY_NOTE = '[binary or non-UTF-8 content]'

interface Entry {
  key: string
  abs: string
  /** Workspace-relative path with forward slashes. */
  path: string
  /** Snapshot when the file existed before the patch. */
  disk?: { bytes: Buffer; text?: string; version: string }
  /** The file exists on disk but is not UTF-8 text; it can be deleted but never edited. */
  binary: boolean
  /** Text after the operations so far; null when the file does not exist (or is binary). */
  content: string | null
  /** Ledger entry of an on-disk file the patch updates, moves or deletes. */
  seen?: FileObservation
  /** Page text that still authorizes hunks (partial reads), evolved by this patch's hunks. */
  segments: readonly string[]
  /** In-order replacements, for the read ledger. */
  edits: Array<{ oldText: string; newText: string }>
  /** The model rewrote the file wholesale (delete then add): it counts as fully known. */
  rewritten: boolean
  /** Normalized text diffs start from, when not the file's own (a move destination). */
  baseline?: string
  movedFrom?: Entry
  movedTo?: Entry
  /** Some operation changed this file's state. */
  dirty: boolean
  /** Order of first mention in the patch. */
  order: number
}

interface Change {
  entry: Entry
  status: 'added' | 'modified' | 'deleted'
}

const exists = (entry: Entry): boolean => entry.binary || entry.content !== null
const normalized = (text: string): string => analyzeText(text).normalized

class PlanFailure extends Error {}

/** Model-facing report of one changed file, plus the UI metadata for it. */
interface Report {
  line: string
  activity: ToolFileActivity
}

function describeChange(change: Change): Report {
  const { entry, status } = change
  const before = entry.baseline ?? (entry.disk ? (entry.disk.text === undefined ? BINARY_NOTE : normalized(entry.disk.text)) : '')
  const after = entry.content === null ? '' : normalized(entry.content)
  // A moved source keeps its content at the destination; the destination reports the real edit.
  const stats = entry.movedTo ? { added: 0, removed: 0, diff: '' } : summarizeDiff(before, after)
  const activity: ToolFileActivity = {
    path: entry.path, status, added: stats.added, removed: stats.removed, ...(stats.diff ? { diff: stats.diff } : {})
  }
  const counts = `(+${stats.added} -${stats.removed})`
  const line = entry.movedFrom
    ? `moved ${entry.movedFrom.path} -> ${entry.path} ${counts}`
    : entry.movedTo ? '' : `${status} ${entry.path} ${counts}`
  return { line, activity }
}

/** Decode the per-file activity a patch result carries as harness metadata. */
export function parseFileActivities(metadata: Record<string, JSONValue> | undefined): ToolFileActivity[] | undefined {
  const raw = metadata?.files
  if (!Array.isArray(raw)) return undefined
  const files: ToolFileActivity[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const { path, status, added, removed, diff } = item as Record<string, JSONValue>
    if (typeof path !== 'string' || !path) continue
    if (status !== 'added' && status !== 'modified' && status !== 'deleted') continue
    if (typeof added !== 'number' || typeof removed !== 'number' || !Number.isFinite(added) || !Number.isFinite(removed)) continue
    files.push({ path, status, added, removed, ...(typeof diff === 'string' && diff ? { diff } : {}) })
  }
  return files.length ? files : undefined
}

const DESCRIPTION =
  'Apply a multi-file patch in one atomic step. The single input `patch` uses this envelope:\n' +
  '*** Begin Patch\n' +
  '*** Add File: path/new.ts\n' +
  '+every line of the new file starts with +\n' +
  '*** Update File: path/existing.ts\n' +
  '*** Move to: path/renamed.ts   (optional)\n' +
  '@@ optional line (e.g. a function signature) that locates the hunk\n' +
  ' context line (starts with a space)\n' +
  '-line to remove\n' +
  '+line to add\n' +
  '*** Delete File: path/old.ts\n' +
  '*** End Patch\n' +
  'Paths are relative to the workspace. Give each hunk about 3 lines of unchanged context before and after the change, and ' +
  'list hunks in file order; small indentation differences in context are tolerated. Read each file you update or delete first ' +
  '(a page read allows hunks on the text it showed; deleting or moving needs a full read). Add File never overwrites an existing ' +
  'file. Everything is validated before anything is written, and the patch is applied all-or-nothing. Line endings, a BOM and ' +
  'the final newline of updated files are preserved. Use edit_file or multi_edit for changes to one file.'

/**
 * A multi-file patch. Every operation is planned against an in-memory view of the
 * workspace first (ledger rules, path guard, hunk matching, destination checks), so a
 * problem anywhere rejects the whole patch before a byte is written. The writes then
 * run with an undo log: if one fails, everything already written is restored.
 */
export function createApplyPatchTool(host: FileMutationHost): ExecutableTool {
  /** Walk up to the workspace root and refuse links: removing or moving must never follow one. */
  const assertNoLinks = async (abs: string): Promise<void> => {
    let ancestor = abs
    while (relative(host.root, ancestor) !== '' && dirname(ancestor) !== ancestor) {
      if ((await fs.lstat(ancestor)).isSymbolicLink()) throw new PlanFailure('apply_patch cannot delete or move a file through a symbolic link or junction.')
      ancestor = dirname(ancestor)
    }
  }

  const tool: ExecutableTool = {
    definition: {
      name: 'apply_patch',
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          patch: { type: 'string', description: 'The whole patch, from "*** Begin Patch" to "*** End Patch".' }
        },
        required: ['patch'],
        additionalProperties: false
      }
    },
    defaultPermission: 'ask',
    async execute(input: JSONValue, ctx: ToolExecutionContext): Promise<ToolResult> {
      const { patch } = (input ?? {}) as { patch?: unknown }
      if (typeof patch !== 'string' || !patch.trim()) return toolFail('apply_patch requires a "patch" string in the "*** Begin Patch" format.')
      if (patch.length > MAX_PATCH_CHARACTERS) return toolFail(`apply_patch accepts patches up to ${MAX_PATCH_CHARACTERS / (1024 * 1024)} MiB; split it into several calls.`)
      // Don't mutate the workspace if the turn was cancelled before we got here.
      if (ctx?.signal?.aborted) return toolFail('apply_patch cancelled.')
      const parsed = parsePatch(patch)
      if (!parsed.ok) return toolFail(`apply_patch failed: ${parsed.error}`)
      if (parsed.operations.length > MAX_OPERATIONS) return toolFail(`apply_patch accepts at most ${MAX_OPERATIONS} files per call; split the patch.`)
      const signal = ctx?.signal

      try {
        // Resolve every path first: one escape rejects the whole patch before anything is read or written.
        const resolved = new Map<string, { abs: string; key: string }>()
        const resolve = (path: string): { abs: string; key: string } => {
          let found = resolved.get(path)
          if (!found) {
            const abs = host.resolvePath(path)
            found = { abs, key: host.observationKey(abs) }
            resolved.set(path, found)
          }
          return found
        }
        for (const op of parsed.operations) {
          resolve(op.path)
          if (op.kind === 'update' && op.moveTo) resolve(op.moveTo)
        }

        const { reports, totals } = await withFileMutations([...resolved.values()].map((item) => item.key), signal, async () => {
          const entries = new Map<string, Entry>()

          const load = async (path: string): Promise<Entry> => {
            const { abs, key } = resolve(path)
            const known = entries.get(key)
            if (known) return known
            let disk: Entry['disk']
            try { disk = await host.readForMutation(abs, signal) }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
            const entry: Entry = {
              key, abs, path: relative(host.root, abs).split(sep).join('/'),
              ...(disk ? { disk } : {}),
              binary: !!disk && disk.text === undefined,
              content: disk?.text ?? null,
              segments: [], edits: [], rewritten: false, dirty: false, order: entries.size
            }
            entries.set(key, entry)
            return entry
          }

          /** Ledger check for an on-disk file; a partial read starts the page text that authorizes hunks. */
          const authorize = (entry: Entry, full: boolean): FileObservation | undefined => {
            if (!entry.disk) return undefined
            const first = !entry.seen
            const seen = host.requireCurrent(entry.key, entry.disk.version, full)
            entry.seen = seen
            if (first) entry.segments = seen.full ? [] : seen.segments
            return seen
          }

          const problems: string[] = []
          for (const op of parsed.operations) {
            try {
              await plan(op)
            } catch (error) {
              if (signal?.aborted) throw error
              problems.push(`${op.path}: ${(error as Error).message}`)
            }
          }

          async function plan(op: PatchOperation): Promise<void> {
            signal?.throwIfAborted()
            if (op.kind === 'add') {
              const entry = await load(op.path)
              if (exists(entry)) throw new PlanFailure(`already exists, so Add File cannot overwrite it. Use "*** Update File:" to change it${entry.disk && !entry.dirty ? ' or delete it first' : ''}.`)
              entry.content = op.lines.map((line) => `${line}\n`).join('')
              entry.rewritten = entry.disk !== undefined
              entry.dirty = true
              return
            }
            const entry = await load(op.path)
            if (!exists(entry)) throw new PlanFailure(`does not exist, so it cannot be ${op.kind === 'delete' ? 'deleted' : 'updated'}. Use "*** Add File:" to create a file.`)
            if (op.kind === 'delete') {
              authorize(entry, true)
              if (entry.disk) await assertNoLinks(entry.abs)
              entry.content = null
              entry.binary = false
              entry.dirty = true
              return
            }
            if (entry.binary) {
              throw new PlanFailure('The file is binary or not valid UTF-8 (e.g. Latin-1/UTF-16). apply_patch will not re-encode it, because that would corrupt every non-ASCII byte.')
            }
            const seen = authorize(entry, !!op.moveTo)
            const source = entry.content!
            let next = source
            if (op.chunks.length > 0) {
              const result = applyChunks(source, op.chunks)
              if (!result.ok) throw new PlanFailure(result.error)
              if (seen && !seen.full) {
                // Only text from the pages the model read may change; each hunk's own result is readable for the next.
                let segments = entry.segments
                result.chunks.forEach((chunk, index) => {
                  if (chunk.oldText === '') {
                    if (!chunk.anchored) throw new PlanFailure(`hunk ${index + 1} only adds lines at the end of the file, which needs a current full read of it. Read the whole file first.`)
                    if (!segments.some((part) => part.includes(chunk.anchorText!))) {
                      throw new PlanFailure(`hunk ${index + 1} inserts after a line that is not included in the pages you read. Read the relevant lines before editing them.`)
                    }
                  } else if (!segments.some((part) => part.includes(chunk.oldText))) {
                    throw new PlanFailure(`hunk ${index + 1} changes text that is not included in the pages you read. Read the relevant lines before editing them.`)
                  }
                  segments = replaceInSegments(segments, chunk.oldText, chunk.newText)
                })
                entry.segments = segments
              }
              next = result.text
              for (const chunk of result.chunks) if (chunk.oldText !== '') entry.edits.push({ oldText: chunk.oldText, newText: chunk.newText })
            }
            if (op.moveTo) {
              const destination = await load(op.moveTo)
              if (destination === entry) throw new PlanFailure('"Move to" names the same file as the source.')
              if (exists(destination)) throw new PlanFailure(`cannot move to ${destination.path}: it already exists.`)
              if (entry.disk) await assertNoLinks(entry.abs)
              destination.content = next
              destination.baseline = normalized(source)
              destination.movedFrom = entry
              destination.dirty = true
              entry.movedTo = destination
              entry.content = null
            } else {
              entry.content = next
            }
            entry.dirty = true
          }

          // Cross-file checks that need the whole plan.
          const live = [...entries.values()].filter((entry) => entry.dirty && entry.content !== null)
          const fold = (path: string): string => (process.platform === 'win32' ? path.toLowerCase() : path)
          for (const entry of live) {
            if (Buffer.byteLength(entry.content!, 'utf8') > MUTATION_LIMIT_BYTES) problems.push(`${entry.path}: the result exceeds the 32 MiB mutation limit.`)
            const prefix = `${fold(entry.path)}/`
            const inside = live.find((other) => fold(other.path).startsWith(prefix))
            if (inside) problems.push(`${inside.path}: cannot be created because ${entry.path} is a file in this patch.`)
          }
          for (const entry of live.filter((item) => !item.disk)) {
            let parent = dirname(entry.abs)
            while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent)
            if (!(await fs.stat(parent)).isDirectory()) problems.push(`${entry.path}: its parent ${relative(host.root, parent).split(sep).join('/')} is a file, not a folder.`)
          }

          if (problems.length > 0) {
            const shown = problems.slice(0, MAX_REPORTED_PROBLEMS)
            const more = problems.length - shown.length
            throw new PlanFailure(`No files were changed.\n\n${shown.join('\n\n')}${more > 0 ? `\n\n... and ${more} more problem${more === 1 ? '' : 's'}.` : ''}`)
          }

          const changes: Change[] = []
          for (const entry of [...entries.values()].sort((a, b) => a.order - b.order)) {
            const existed = entry.disk !== undefined
            if (!entry.dirty || (!existed && !exists(entry))) continue
            if (existed && entry.content !== null && entry.content === entry.disk!.text && !entry.movedFrom) continue
            changes.push({ entry, status: !existed ? 'added' : exists(entry) ? 'modified' : 'deleted' })
          }
          if (changes.length === 0) throw new PlanFailure('The patch leaves every file as it is. No files were changed.')

          await write(changes, signal)
          const reports = changes.map(describeChange)
          return { reports, totals: reports.reduce((sum, report) => ({ added: sum.added + report.activity.added, removed: sum.removed + report.activity.removed }), { added: 0, removed: 0 }) }
        })

        const lines = reports.map((report) => report.line).filter(Boolean)
        const listed = lines.slice(0, MAX_LISTED_FILES)
        let diffBudget = MAX_DIFF_LINES
        const files = reports.map(({ activity }): ToolFileActivity => {
          if (!activity.diff) return activity
          const size = activity.diff.split('\n').length
          if (size > diffBudget) return { path: activity.path, status: activity.status, added: activity.added, removed: activity.removed }
          diffBudget -= size
          return activity
        })
        const result = toolOk(
          `Applied patch: ${lines.length} file${lines.length === 1 ? '' : 's'} changed (+${totals.added} -${totals.removed}).\n` +
          `${listed.join('\n')}${lines.length > listed.length ? `\n... and ${lines.length - listed.length} more files` : ''} ` +
          diffTotalsMarker(totals.added, totals.removed)
        )
        return { ...result, metadata: { files: files as unknown as JSONValue } }
      } catch (error) {
        if (signal?.aborted) return toolFail('apply_patch cancelled.')
        const message = (error as Error).message
        return toolFail(error instanceof PlanFailure && message.startsWith('No files') ? `apply_patch failed. ${message}` : `apply_patch failed: ${message}`)
      }
    }
  }

  /** Write the planned changes (creates, then edits, then deletes); undo everything if one step fails. */
  const write = async (changes: Change[], signal: AbortSignal | undefined): Promise<void> => {
    const ordered = [
      ...changes.filter((change) => change.status === 'added'),
      ...changes.filter((change) => change.status === 'modified'),
      ...changes.filter((change) => change.status === 'deleted')
    ]
    const undo: Array<{ path: string; run: () => Promise<void> }> = []
    const createdDirectories: string[] = []
    let current = ''
    try {
      // Stale files are caught before the first byte is written.
      for (const { entry } of ordered) if (entry.disk) await host.verifyBeforeMutation(entry.abs, entry.disk.version, signal)
      for (const { entry, status } of ordered) {
        signal?.throwIfAborted()
        current = entry.path
        if (status === 'added') {
          const missing: string[] = []
          for (let dir = dirname(entry.abs); !existsSync(dir) && dirname(dir) !== dir; dir = dirname(dir)) missing.push(dir)
          await fs.mkdir(dirname(entry.abs), { recursive: true })
          createdDirectories.push(...missing)
          // A folder swapped for a link while we worked must not redirect the write.
          host.resolvePath(entry.path)
          // 'wx': a file another actor created in the meantime is never overwritten.
          await fs.writeFile(entry.abs, entry.content!, { encoding: 'utf8', flag: 'wx' })
          undo.push({ path: entry.path, run: () => fs.rm(entry.abs, { force: true }) })
        } else if (status === 'modified') {
          const disk = entry.disk!
          await host.verifyBeforeMutation(entry.abs, disk.version, signal)
          await host.atomicReplace(entry.abs, entry.content!)
          undo.push({ path: entry.path, run: () => restoreBytes(entry.abs, disk.bytes) })
        } else {
          const disk = entry.disk!
          await host.verifyBeforeMutation(entry.abs, disk.version, signal)
          await fs.unlink(entry.abs)
          undo.push({
            path: entry.path,
            run: async () => {
              await fs.mkdir(dirname(entry.abs), { recursive: true })
              await fs.writeFile(entry.abs, disk.bytes, { flag: 'wx' })
            }
          })
        }
      }
    } catch (error) {
      const unrestored: string[] = []
      for (const step of undo.reverse()) {
        try { await step.run() } catch (undoError) { unrestored.push(`${step.path} (${(undoError as Error).message})`) }
      }
      for (const dir of createdDirectories.sort((a, b) => b.length - a.length)) await fs.rmdir(dir).catch(() => undefined)
      // Restored files are back to the bytes the model read; re-observe them so a corrected patch needs no new read.
      for (const { entry } of changes) await reobserve(entry)
      if (signal?.aborted) throw error
      throw new Error(
        `could not write ${current || 'the files'}: ${(error as Error).message}. ` +
        (unrestored.length > 0
          ? `Rollback was incomplete; check these files: ${unrestored.join(', ')}.`
          : 'Every earlier change was rolled back, so no files were changed.')
      )
    }

    // Past this point nothing can fail the patch: checkpoint every file, then refresh the read ledger.
    for (const { entry, status } of ordered) {
      host.onMutate?.(entry.abs, entry.disk?.bytes ?? Buffer.alloc(0), entry.disk !== undefined, status === 'deleted' ? null : Buffer.from(entry.content!, 'utf8'))
    }
    for (const { entry, status } of changes) {
      try {
        if (status === 'deleted') { host.observations.forget(entry.key); continue }
        const version = await host.recordWritten(entry.abs, entry.key, entry.content!)
        // An in-place edit keeps the partial/full state of the read; a created, moved or rewritten file is fully known.
        if (entry.seen && !entry.rewritten && !entry.movedFrom) host.observations.afterEdits(entry.key, version, entry.seen, entry.edits)
        else host.observations.record(entry.key, version, true)
      } catch {
        host.observations.forget(entry.key)
      }
    }
  }

  const restoreBytes = async (abs: string, bytes: Buffer): Promise<void> => {
    try { await host.atomicReplace(abs, bytes) } catch { await fs.writeFile(abs, bytes) }
  }

  const reobserve = async (entry: Entry): Promise<void> => {
    const { observations } = host
    if (!entry.disk) { observations.forget(entry.key); return }
    try {
      const now = await host.readForMutation(entry.abs)
      if (now.version === entry.disk.version) return
      if (now.bytes.equals(entry.disk.bytes) && entry.seen) observations.record(entry.key, now.version, entry.seen.full, entry.seen.segments)
      else observations.forget(entry.key)
    } catch {
      observations.forget(entry.key)
    }
  }

  return tool
}
