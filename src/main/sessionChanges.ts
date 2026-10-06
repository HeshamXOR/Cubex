import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, promises as fs, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { condenseDiff, lineDiff, serializeDiff, type DiffLine } from '@core/tools/lineDiff'
import type { HunkRevertResult, ReviewFile, ReviewHunk, ReviewScope, SessionFileChange, SessionRevertResult } from '@shared/ipc'
import { resolveWorkspacePath } from './workspaceFiles'
import { buildReviewFile, changedRange, reverseHunks, reviewFileLevel, REVIEW_MAX_BYTES } from './reviewModel'
export type { HunkRevertResult, ReviewFile, ReviewHunk, ReviewScope, SessionFileChange, SessionRevertResult } from '@shared/ipc'

/** Larger originals are reported as changed but never copied, so they cannot be restored. */
export const SESSION_BASELINE_MAX_BYTES = 5 * 1024 * 1024
/** Stored originals per task. Files first changed beyond this get no restore point. */
export const SESSION_TASK_MAX_BYTES = 64 * 1024 * 1024
export const EXTERNAL_EDIT_REASON = 'Changed outside Cubex since its last edit'
const MAX_TRACKED_FILES = 2_000
const MAX_INDEX_BYTES = 4 * 1024 * 1024
/**
 * Hunks that left the review stay in the index so a request naming one the file has moved past can still be found.
 * They are only a cache: the index must stay under MAX_INDEX_BYTES to be read back, or the task's changes are lost at the next start.
 */
const MAX_REMEMBERED_HUNK_BYTES = 768 * 1024
/** Cubex never writes more than 32 MiB, so a bigger file was replaced elsewhere. */
const MAX_COMPARE_BYTES = 64 * 1024 * 1024
const MAX_DIFF_LINES = 2_000
const MAX_REVERT_PATHS = 2_000
const HASH = /^[a-f0-9]{64}$/

interface ContentRef { hash: string; size: number }

interface TurnBaseline {
  messageId: string
  before: (ContentRef & { kept: boolean }) | null
}

interface TrackedFile {
  /** Absolute path exactly as the file tools resolved it. */
  path: string
  /** Pre-task content; null when Cubex created the file. `kept` is false when no copy was stored. */
  baseline: (ContentRef & { kept: boolean }) | null
  /** Cubex's last written content; null when Cubex removed the file. */
  latest: ContentRef | null
  /** Canonical parent + basename at Cubex's last write, so a swapped junction is detected. */
  location: string
  updatedAt: number
  turns?: TurnBaseline[]
}

interface TaskHunkState {
  state: 'accepted'
  headHash: string
}

interface SoftRevertFile {
  path: string
  absPath: string
  preRevertHash: string
  postRevertHash: string
  existedBefore: boolean
  existedAfter: boolean
  acceptedHunkIds?: string[]
  trackedEntry?: TrackedFile
}

interface SoftRevertRecord {
  id: string
  conversationId: string
  createdAt: number
  files: SoftRevertFile[]
  notes?: Array<{ path: string; lineRange?: string; wholeFile?: boolean }>
}

interface TaskIndex {
  version: 1
  conversationId: string
  files: TrackedFile[]
  hunkStates?: Record<string, TaskHunkState>
  hunks?: Record<string, ReviewHunk>
  revision?: number
  currentTurnId?: string
  reviewNotes?: {
    reverts?: Array<{ path: string; lineRange?: string; wholeFile?: boolean; revertId: string }>
    accepted?: Record<string, number>
  }
}

function formatReviewNotes(notes: NonNullable<TaskIndex['reviewNotes']>): string | undefined {
  const parts: string[] = []
  if (notes.reverts && notes.reverts.length > 0) {
    for (const rev of notes.reverts) {
      if (rev.wholeFile) {
        parts.push(`Reverted ${rev.path}: whole file reverted`)
      } else if (rev.lineRange) {
        parts.push(`Reverted in ${rev.path}: ${rev.lineRange}`)
      }
    }
  }
  if (notes.accepted) {
    for (const [path, count] of Object.entries(notes.accepted)) {
      if (count > 0) {
        parts.push(`Accepted in ${path}: ${count} ${count === 1 ? 'hunk' : 'hunks'}`)
      }
    }
  }
  if (parts.length === 0) return undefined
  return `<review-state>\n${parts.join('\n')}\n</review-state>`
}

type DiskState = { kind: 'absent' } | { kind: 'file'; hash: string; size: number; bytes: Buffer } | { kind: 'other' }

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const refOf = (bytes: Buffer): ContentRef => ({ hash: sha256(bytes), size: bytes.length })
const fileKey = (path: string): string => (process.platform === 'win32' ? path.toLowerCase() : path)
const samePath = (a: string, b: string): boolean => fileKey(a) === fileKey(b)

function sameContent(disk: DiskState, ref: ContentRef | null): boolean {
  if (ref === null) return disk.kind === 'absent'
  return disk.kind === 'file' && disk.hash === ref.hash && disk.size === ref.size
}

/** The most recently seen hunks that fit the budget, oldest first. A hunk too big to fit alone is not kept. */
function newestHunks(hunks: Record<string, ReviewHunk>, budget: number): Record<string, ReviewHunk> {
  const ids = Object.keys(hunks)
  const kept: string[] = []
  let bytes = 0
  for (let i = ids.length - 1; i >= 0; i--) {
    const size = JSON.stringify(hunks[ids[i]!]).length
    if (bytes + size > budget) continue
    bytes += size
    kept.push(ids[i]!)
  }
  return Object.fromEntries(kept.reverse().map((id) => [id, hunks[id]!]))
}

function taskKey(conversationId: unknown): string {
  if (typeof conversationId !== 'string' || !conversationId.trim() || conversationId.length > 256) {
    throw new Error('A valid task id is required for session changes.')
  }
  // Imported conversation IDs need not be filesystem-safe. No ID becomes a path.
  return createHash('sha256').update(conversationId).digest('hex').slice(0, 32)
}

/** Workspace-relative POSIX path, or undefined when the file lies outside the root. */
function workspaceRelative(root: string, path: string): string | undefined {
  const rel = relative(root, path)
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return undefined
  return rel.split(sep).join('/')
}

function validRef(value: unknown): value is ContentRef {
  const ref = value as ContentRef | null
  return !!ref && typeof ref.hash === 'string' && HASH.test(ref.hash) && Number.isSafeInteger(ref.size) && ref.size >= 0
}

function validTurn(value: unknown): value is TurnBaseline {
  const t = value as TurnBaseline | null
  return !!t && typeof t.messageId === 'string' && (t.before === null || (validRef(t.before) && typeof t.before.kept === 'boolean'))
}

function validEntry(value: unknown): value is TrackedFile {
  const entry = value as TrackedFile | null
  return !!entry && typeof entry.path === 'string' && entry.path.length <= 4096 && !entry.path.includes('\0') && isAbsolute(entry.path) &&
    typeof entry.location === 'string' && isAbsolute(entry.location) && Number.isFinite(entry.updatedAt) &&
    (entry.baseline === null || (validRef(entry.baseline) && typeof entry.baseline.kept === 'boolean')) &&
    (entry.latest === null || validRef(entry.latest)) &&
    (entry.turns === undefined || (Array.isArray(entry.turns) && entry.turns.every(validTurn)))
}

/** Strict UTF-8 without NUL bytes; binary, oversized or re-encoded content gets no line diff. */
function diffableText(bytes: Buffer | undefined): string | undefined {
  if (!bytes || bytes.length > SESSION_BASELINE_MAX_BYTES || bytes.includes(0)) return undefined
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { return undefined }
}

/**
 * Condensed line diff with counts. Unchanged leading and trailing lines are
 * trimmed before the LCS, so a small edit in a large file stays fast; they
 * come back as context for condenseDiff to collapse.
 */
export function summarizeTextDiff(before: string, after: string): { added: number; removed: number; diff: string } {
  const a = before.length ? before.split('\n') : []
  const b = after.length ? after.split('\n') : []
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  // lineDiff takes text: a one-character prefix keeps a lone empty line from reading as "no lines".
  const joined = (lines: string[]): string => lines.map((line) => `\u0001${line}`).join('\n')
  const middle = lineDiff(joined(a.slice(start, endA)), joined(b.slice(start, endB)))
  // Past lineDiff's size guard the middle is one "N lines replaced with M lines" marker.
  const coarse = (endA - start) * (endB - start) > 4_000_000
  const changes: DiffLine[] = coarse ? middle : middle.map((line) => ({ tag: line.tag, text: line.text.slice(1) }))
  const context = (lines: string[]): DiffLine[] => lines.map((text) => ({ tag: ' ', text }))
  let lines = condenseDiff([...context(a.slice(0, start)), ...changes, ...context(a.slice(endA))], 3)
  if (lines.length > MAX_DIFF_LINES) {
    const rest = lines.length - MAX_DIFF_LINES
    lines = [...lines.slice(0, MAX_DIFF_LINES), { tag: '@', text: `⋯ ${rest} more line${rest === 1 ? '' : 's'} not shown` }]
  }
  return {
    added: coarse ? endB - start : changes.filter((line) => line.tag === '+').length,
    removed: coarse ? endA - start : changes.filter((line) => line.tag === '-').length,
    diff: serializeDiff(lines)
  }
}

/** Current state of a path, never following a final symlink. */
async function readDisk(path: string): Promise<DiskState> {
  const stat = await fs.lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined
    throw error
  })
  if (!stat) return { kind: 'absent' }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_COMPARE_BYTES) return { kind: 'other' }
  const bytes = await fs.readFile(path)
  return { kind: 'file', ...refOf(bytes), bytes }
}

/** Write beside the target, then rename over it: a crash never leaves a truncated file. */
async function replaceFile(target: string, bytes: Buffer): Promise<void> {
  const mode = await fs.stat(target).then((stat) => stat.mode & 0o7777, () => 0o666)
  const temp = `${target}.cubex-${randomUUID()}.tmp`
  const handle = await fs.open(temp, 'wx', mode)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    await fs.rename(temp, target)
  } catch (error) {
    await handle.close().catch(() => undefined)
    await fs.rm(temp, { force: true })
    throw error
  }
}

function restoreFailure(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return 'The file is locked or read-only. Close programs using it and try again.'
  return `Could not restore it: ${(error as Error).message}`
}

/** IPC input: undefined (every file) or a bounded list of workspace-relative paths. */
export function validateRevertPaths(paths: unknown): string[] | undefined {
  if (paths === undefined || paths === null) return undefined
  if (!Array.isArray(paths) || paths.length > MAX_REVERT_PATHS ||
      !paths.every((path) => typeof path === 'string' && path.trim() && path.length <= 4096 && !path.includes('\0'))) {
    throw new Error('Paths must be a list of workspace-relative file paths.')
  }
  return paths as string[]
}

export interface SessionChangeStoreOptions {
  onError?: (error: unknown) => void
  maxBaselineBytes?: number
  maxTaskBytes?: number
  /** Called after a task's review state changed and was saved (a file was written, a hunk reverted or accepted, an undo). */
  onChange?: (conversationId: string, revision: number) => void
}

/**
 * Net file changes per task, for the review panel. The first mutation of a path
 * keeps its pre-task bytes (or notes that Cubex created it) in a content-addressed
 * blob; every mutation records a hash of what Cubex wrote, so edits made
 * elsewhere are detected and never overwritten. Unlike CheckpointStore this is
 * durable: index.json and blobs/ live under the task's own directory.
 */
export class SessionChangeStore {
  private readonly root: string
  private readonly indexes = new Map<string, Map<string, TrackedFile>>()
  private readonly rawIndexes = new Map<string, TaskIndex>()
  /** Highest revision handed out per task in this process: an index that was deleted (nothing left to review) must not restart the count. */
  private readonly revisions = new Map<string, number>()
  private readonly onError: (error: unknown) => void
  private readonly onChange: ((conversationId: string, revision: number) => void) | undefined
  private readonly maxBaselineBytes: number
  private readonly maxTaskBytes: number

  constructor(root: string, options: SessionChangeStoreOptions = {}) {
    const path = resolve(root)
    mkdirSync(path, { recursive: true })
    if (lstatSync(path).isSymbolicLink()) throw new Error('Session change storage cannot be a symbolic link.')
    this.root = realpathSync.native(path)
    this.onError = options.onError ?? (() => {})
    this.onChange = options.onChange
    this.maxBaselineBytes = options.maxBaselineBytes ?? SESSION_BASELINE_MAX_BYTES
    this.maxTaskBytes = options.maxTaskBytes ?? SESSION_TASK_MAX_BYTES
  }

  private getRawIndex(conversationId: string): TaskIndex {
    const key = taskKey(conversationId)
    let raw = this.rawIndexes.get(key)
    if (!raw) {
      this.load(conversationId)
      raw = this.rawIndexes.get(key)!
    }
    return raw
  }

  revision(conversationId: string): number {
    return Math.max(this.getRawIndex(conversationId).revision ?? 0, this.revisions.get(taskKey(conversationId)) ?? 0)
  }

  /** Count a change to the task's review state. Call before `save`, so the number is stored with it. */
  private bump(conversationId: string): number {
    const raw = this.getRawIndex(conversationId)
    raw.revision = this.revision(conversationId) + 1
    this.revisions.set(taskKey(conversationId), raw.revision)
    return raw.revision
  }

  /** A listener must never turn a finished edit or revert into a failure. */
  private notify(conversationId: string, revision: number): void {
    try { this.onChange?.(conversationId, revision) } catch (error) { this.onError(error) }
  }

  /** Save a change to the task's review state and tell the listener, which refetches only after it is stored. */
  private commit(conversationId: string, files: Map<string, TrackedFile>): void {
    const revision = this.bump(conversationId)
    this.save(conversationId, files)
    this.notify(conversationId, revision)
  }

  beginTurn(conversationId: string, turnId: string): void {
    const files = this.load(conversationId)
    const raw = this.getRawIndex(conversationId)
    raw.currentTurnId = turnId
    this.save(conversationId, files)
  }

  forgetTurnsSince(conversationId: string, turnId: string): void {
    const files = this.load(conversationId)
    for (const file of files.values()) {
      if (!file.turns) continue
      const idx = file.turns.findIndex((t) => t.messageId === turnId)
      if (idx >= 0) file.turns.splice(idx)
    }
    const raw = this.getRawIndex(conversationId)
    if (raw.currentTurnId === turnId) {
      raw.currentTurnId = undefined
    }
    this.save(conversationId, files)
  }

  /**
   * Note a file tool's successful mutation (the onMutate callback). Never
   * throws: bookkeeping must not turn a completed edit into a failed tool call.
   */
  record(conversationId: string, path: string, before: Buffer, existed: boolean, after?: Buffer | null, turnId?: string): void {
    try {
      const files = this.load(conversationId)
      const raw = this.getRawIndex(conversationId)
      const key = fileKey(path)
      const latest = after === undefined ? this.currentRef(path) : after === null ? null : refOf(after)
      const location = join(realpathSync.native(dirname(path)), basename(path))
      let entry = files.get(key)
      if (!entry) {
        if (files.size >= MAX_TRACKED_FILES) throw new Error(`Session change tracking is limited to ${MAX_TRACKED_FILES} files per task.`)
        entry = { path, baseline: existed ? this.keepBaseline(conversationId, files, before) : null, latest, location, updatedAt: Date.now() }
        files.set(key, entry)
      } else Object.assign(entry, { path, latest, location, updatedAt: Date.now() })

      const activeTurn = turnId ?? raw.currentTurnId
      if (activeTurn) {
        entry.turns = entry.turns ?? []
        if (!entry.turns.some((t) => t.messageId === activeTurn)) {
          entry.turns.push({
            messageId: activeTurn,
            before: existed ? this.keepBaseline(conversationId, files, before) : null
          })
        }
      }

      // Back at its original state: nothing is left to review or undo.
      if (entry.baseline === null ? latest === null : latest !== null && latest.hash === entry.baseline.hash) files.delete(key)
      this.commit(conversationId, files)
    } catch (error) { this.onError(error) }
  }

  /** After a rewind wrote files back, their current contents count as Cubex's latest write. */
  async syncRestored(conversationId: string, paths: string[]): Promise<void> {
    try {
      const files = this.load(conversationId)
      let changed = false
      for (const path of paths) {
        const entry = files.get(fileKey(path))
        if (!entry) continue
        const disk = await readDisk(path)
        if (disk.kind === 'other') continue
        changed = true
        if (sameContent(disk, entry.baseline)) files.delete(fileKey(path))
        else Object.assign(entry, { latest: disk.kind === 'file' ? { hash: disk.hash, size: disk.size } : null, updatedAt: Date.now() })
      }
      if (changed) this.commit(conversationId, files)
    } catch (error) { this.onError(error) }
  }

  /** Net change per tracked file inside the task's workspace; files back at their original state are omitted. */
  async list(conversationId: string, workspace: string | undefined): Promise<SessionFileChange[]> {
    const files = this.load(conversationId)
    if (!workspace || !files.size) return []
    const root = resolve(workspace)
    const changes: SessionFileChange[] = []
    for (const entry of files.values()) {
      const path = workspaceRelative(root, entry.path)
      if (path === undefined) continue
      try {
        const change = await this.describe(conversationId, entry, path)
        if (change) changes.push(change)
      } catch (error) { this.onError(error) }
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path))
  }

  async review(conversationId: string, workspace: string, scope: ReviewScope): Promise<ReviewFile[]> {
    if (!workspace || typeof workspace !== 'string') throw new Error('No workspace folder selected for this task.')
    const root = resolve(workspace)
    if (scope.kind !== 'session' && scope.kind !== 'turn') {
      throw new Error(`Review scope "${(scope as { kind: string }).kind}" is not supported yet.`)
    }
    const files = this.load(conversationId)
    const raw = this.getRawIndex(conversationId)
    const hunkStates = raw.hunkStates ?? {}
    const rawHunks = raw.hunks ?? {}
    let learned = false
    const reviewFiles: ReviewFile[] = []

    for (const entry of files.values()) {
      const rel = workspaceRelative(root, entry.path)
      if (rel === undefined) continue

      let baselineRef: (ContentRef & { kept: boolean }) | null | undefined
      if (scope.kind === 'session') {
        baselineRef = entry.baseline
      } else {
        const turn = entry.turns?.find((t) => t.messageId === scope.messageId)
        if (!turn) continue
        baselineRef = turn.before
      }

      const disk = await readDisk(entry.path)
      if (sameContent(disk, baselineRef)) continue

      const beforeText = baselineRef === null ? null : baselineRef.kept ? diffableText(this.readBlob(conversationId, baselineRef)) : undefined
      const afterText = disk.kind === 'absent' ? null : disk.kind === 'file' ? diffableText(disk.bytes) : undefined
      const headHash = disk.kind === 'file' ? disk.hash : null
      const externallyModified = !sameContent(disk, entry.latest) ? true : undefined

      let revFile: ReviewFile
      const isBinary = (baselineRef && !baselineRef.kept) ||
        (beforeText === undefined && baselineRef !== null) ||
        (afterText === undefined && disk.kind === 'file')
      const isOversize = (baselineRef && baselineRef.size > REVIEW_MAX_BYTES) ||
        (disk.kind === 'file' && disk.size > REVIEW_MAX_BYTES)

      if (isBinary) {
        revFile = reviewFileLevel(rel, beforeText ?? null, afterText ?? null, {
          binary: true, headHash, updatedAt: entry.updatedAt, externallyModified
        })
      } else if (isOversize) {
        revFile = reviewFileLevel(rel, beforeText ?? null, afterText ?? null, {
          oversize: true, headHash, updatedAt: entry.updatedAt, externallyModified
        })
      } else {
        revFile = buildReviewFile(rel, beforeText ?? null, afterText ?? null, {
          headHash, updatedAt: entry.updatedAt, externallyModified
        })
      }

      for (const h of revFile.hunks) {
        if (!(h.id in rawHunks)) learned = true
        // Re-added last, so the hunks seen most recently are the ones kept when the budget runs out.
        delete rawHunks[h.id]
        rawHunks[h.id] = h
        const state = hunkStates[h.id]
        if (state && state.state === 'accepted' && state.headHash === headHash) {
          h.state = 'accepted'
        } else {
          h.state = 'pending'
        }
      }

      reviewFiles.push(revFile)
    }

    // Asking again changes nothing worth writing; a hunk seen for the first time is saved with the index.
    if (learned) {
      raw.hunks = newestHunks(rawHunks, MAX_REMEMBERED_HUNK_BYTES)
      this.save(conversationId, files)
    }

    return reviewFiles.sort((a, b) => a.path.localeCompare(b.path))
  }

  async findHunk(conversationId: string, workspace: string, path: string, hunkId: string): Promise<ReviewHunk | undefined> {
    if (!workspace || isAbsolute(path) || /^[A-Za-z]:/.test(path)) return undefined
    const root = resolve(workspace)
    const rel = workspaceRelative(root, resolve(root, path))
    if (rel === undefined) return undefined
    const files = await this.review(conversationId, workspace, { kind: 'session' })
    const file = files.find((f) => f.path === rel)
    return file?.hunks.find((h) => h.id === hunkId)
  }

  async markReviewed(
    conversationId: string,
    workspace: string,
    items: Array<{ path: string; hunkIds: string[]; headHash: string }>
  ): Promise<void> {
    if (!workspace || !Array.isArray(items)) return
    const root = resolve(workspace)
    const files = this.load(conversationId)
    const raw = this.getRawIndex(conversationId)
    const current = await this.review(conversationId, workspace, { kind: 'session' })

    let changed = false
    for (const item of items) {
      if (!item.path || typeof item.path !== 'string' || !Array.isArray(item.hunkIds)) continue
      if (isAbsolute(item.path) || /^[A-Za-z]:/.test(item.path)) continue
      const rel = workspaceRelative(root, resolve(root, item.path))
      if (rel === undefined || !HASH.test(item.headHash)) continue
      // Honored only while the file still has the bytes the person looked at.
      const file = current.find((f) => f.path === rel)
      if (!file || file.headHash !== item.headHash) continue

      for (const id of item.hunkIds) {
        const hunk = file.hunks.find((h) => h.id === id)
        // Accepting a hunk again must not count it twice in the note the model gets.
        if (!hunk || hunk.state === 'accepted' || raw.hunkStates?.[id]?.headHash === item.headHash) continue
        raw.hunkStates = { ...raw.hunkStates, [id]: { state: 'accepted', headHash: item.headHash } }
        const accepted = raw.reviewNotes?.accepted ?? {}
        raw.reviewNotes = { ...raw.reviewNotes, accepted: { ...accepted, [rel]: (accepted[rel] ?? 0) + 1 } }
        changed = true
      }
    }

    if (changed) this.commit(conversationId, files)
  }

  async revertHunks(
    conversationId: string,
    workspace: string,
    req: { path: string; hunkIds: string[]; expectHeadHash: string }
  ): Promise<HunkRevertResult> {
    if (!workspace || typeof workspace !== 'string') throw new Error('No workspace folder selected for this task.')
    const root = resolve(workspace)
    if (!req || typeof req.path !== 'string' || isAbsolute(req.path) || /^[A-Za-z]:/.test(req.path)) {
      throw new Error('Paths must be relative to the workspace.')
    }
    const rel = workspaceRelative(root, resolve(root, req.path))
    if (rel === undefined) throw new Error('Path escapes the workspace.')
    if (!Array.isArray(req.hunkIds) || req.hunkIds.length === 0) {
      throw new Error('At least one hunk id is required.')
    }
    if (req.expectHeadHash !== '' && !HASH.test(req.expectHeadHash)) {
      throw new Error('A valid 64-character hex hash is required.')
    }

    const target = resolve(root, rel)
    const key = fileKey(target)
    const files = this.load(conversationId)
    const entry = files.get(key)
    if (!entry) throw new Error(`File "${req.path}" was not changed in this task.`)

    const disk = await readDisk(target)

    if (
      (entry.baseline && !entry.baseline.kept) ||
      (entry.baseline && entry.baseline.size > REVIEW_MAX_BYTES) ||
      (disk.kind === 'file' && (disk.size > REVIEW_MAX_BYTES || disk.bytes.includes(0))) ||
      (entry.baseline && this.readBlob(conversationId, entry.baseline)?.includes(0))
    ) {
      throw new Error('Binary and oversize files can only be reverted as a whole file.')
    }

    const raw = this.getRawIndex(conversationId)
    const revertId = randomUUID()

    // Case 1: Created file whole-hunk revert
    if (entry.baseline === null) {
      if (disk.kind !== 'file') throw new Error('File does not exist.')
      const preRevertHash = disk.hash
      this.writeAtomic(join(this.directory(conversationId, true), 'blobs', preRevertHash), disk.bytes)
      await fs.unlink(target)
      const softRecord: SoftRevertRecord = {
        id: revertId,
        conversationId,
        createdAt: Date.now(),
        files: [{
          path: rel,
          absPath: entry.path,
          preRevertHash,
          postRevertHash: '',
          existedBefore: true,
          existedAfter: false,
          trackedEntry: { ...entry }
        }],
        notes: [{ path: rel, wholeFile: true }]
      }
      this.saveSoftRevert(conversationId, softRecord)
      raw.reviewNotes = raw.reviewNotes ?? {}
      raw.reviewNotes.reverts = raw.reviewNotes.reverts ?? []
      raw.reviewNotes.reverts.push({ path: rel, wholeFile: true, revertId })
      this.commit(conversationId, files)
      return { applied: req.hunkIds, conflicts: [], newHeadHash: null, revertId }
    }

    // Case 2: Deleted file whole-hunk revert
    if (disk.kind === 'absent') {
      const original = this.readBlob(conversationId, entry.baseline!)
      if (!original) throw new Error('Saved original is missing or damaged.')
      await replaceFile(target, original)
      const newHeadHash = entry.baseline!.hash
      const softRecord: SoftRevertRecord = {
        id: revertId,
        conversationId,
        createdAt: Date.now(),
        files: [{
          path: rel,
          absPath: entry.path,
          preRevertHash: '',
          postRevertHash: newHeadHash,
          existedBefore: false,
          existedAfter: true,
          trackedEntry: { ...entry }
        }],
        notes: [{ path: rel, wholeFile: true }]
      }
      this.saveSoftRevert(conversationId, softRecord)
      raw.reviewNotes = raw.reviewNotes ?? {}
      raw.reviewNotes.reverts = raw.reviewNotes.reverts ?? []
      raw.reviewNotes.reverts.push({ path: rel, wholeFile: true, revertId })
      this.commit(conversationId, files)
      return { applied: req.hunkIds, conflicts: [], newHeadHash, revertId }
    }

    // Case 3: Regular text file hunk revert
    if (disk.kind !== 'file') throw new Error('File does not exist.')
    const currentText = diffableText(disk.bytes)
    if (currentText === undefined) throw new Error('Binary and oversize files can only be reverted as a whole file.')

    const drifted = req.expectHeadHash !== '' && disk.hash !== req.expectHeadHash

    // Find target hunks to reverse:
    // First, inspect hunks of the CURRENT disk content
    const currentRevFiles = await this.review(conversationId, workspace, { kind: 'session' })
    const currentRevFile = currentRevFiles.find((f) => f.path === rel)
    const targetHunks: ReviewHunk[] = []

    for (const id of req.hunkIds) {
      const currentHunk = currentRevFile?.hunks.find((h) => h.id === id)
      if (currentHunk) {
        targetHunks.push(currentHunk)
      } else if (raw.hunks?.[id]) {
        targetHunks.push(raw.hunks[id]!)
      }
    }

    if (targetHunks.length === 0) {
      throw new Error('Requested hunks were not found.')
    }

    const revMany = reverseHunks(currentText, targetHunks, { fuzz: 3 })
    if (revMany.conflicts.length > 0) {
      return {
        applied: [],
        conflicts: revMany.conflicts.map((c) => ({ hunkId: c.id, reason: c.reason })),
        newHeadHash: disk.hash
      }
    }

    const newText = revMany.text
    const newBytes = Buffer.from(newText, 'utf8')
    const newHeadHash = sha256(newBytes)

    this.writeAtomic(join(this.directory(conversationId, true), 'blobs', disk.hash), disk.bytes)
    await replaceFile(target, newBytes)

    // What undo puts back: the entry as it was before this revert changed its bookkeeping.
    const trackedBefore: TrackedFile = { ...entry }
    const hadExternalEdits = !sameContent(disk, entry.latest)
    if (!hadExternalEdits) {
      entry.latest = { hash: newHeadHash, size: newBytes.length }
      entry.updatedAt = Date.now()
    }

    const acceptedHunkIds: string[] = []
    if (raw.hunkStates) {
      for (const [hId, st] of Object.entries(raw.hunkStates)) {
        if (st.state === 'accepted' && st.headHash === disk.hash) {
          acceptedHunkIds.push(hId)
          st.headHash = newHeadHash
        }
      }
    }

    const lineRanges = targetHunks.map((h) => {
      const range = changedRange(h)
      return range.start === range.end ? `line ${range.start}` : `lines ${range.start}-${range.end}`
    }).join(', ')

    const softRecord: SoftRevertRecord = {
      id: revertId,
      conversationId,
      createdAt: Date.now(),
      files: [{
        path: rel,
        absPath: entry.path,
        preRevertHash: disk.hash,
        postRevertHash: newHeadHash,
        existedBefore: true,
        existedAfter: true,
        acceptedHunkIds,
        trackedEntry: trackedBefore
      }],
      notes: [{ path: rel, lineRange: lineRanges }]
    }
    this.saveSoftRevert(conversationId, softRecord)

    raw.reviewNotes = raw.reviewNotes ?? {}
    raw.reviewNotes.reverts = raw.reviewNotes.reverts ?? []
    raw.reviewNotes.reverts.push({ path: rel, lineRange: lineRanges, revertId })
    this.commit(conversationId, files)

    const hasFuzzOrDrift = revMany.applied.some((a) => a.fuzz > 0 || a.offset !== 0) || drifted
    const fuzzy = hasFuzzOrDrift
      ? revMany.applied.map((a) => ({ hunkId: a.id, fuzz: a.fuzz, offset: a.offset, drift: drifted }))
      : undefined

    return {
      applied: revMany.applied.map((a) => a.id),
      conflicts: [],
      newHeadHash,
      revertId,
      ...(fuzzy ? { fuzzy } : {})
    }
  }

  /**
   * Restore files to their pre-task state: write the original bytes back, or
   * delete files Cubex created. Files edited elsewhere since Cubex's last write
   * are skipped. Restored files stop being tracked; `files` lists their
   * absolute paths so the caller can drop matching rewind snapshots.
   */
  async revert(conversationId: string, workspace: string | undefined, paths?: string[]): Promise<{ result: SessionRevertResult; files: string[] }> {
    const requested = validateRevertPaths(paths)
    const files = this.load(conversationId)
    const raw = this.getRawIndex(conversationId)
    const result: SessionRevertResult = { restored: [], skipped: [] }
    const restoredFiles: string[] = []
    if (!workspace) {
      if (requested?.length) throw new Error('No workspace folder selected for this task.')
      return { result, files: restoredFiles }
    }
    const root = resolve(workspace)
    const targets = new Map<string, { path: string; entry?: TrackedFile }>()
    if (requested === undefined) {
      for (const [key, entry] of files) {
        const path = workspaceRelative(root, entry.path)
        if (path !== undefined) targets.set(key, { path, entry })
      }
    } else {
      // Validate every path before touching any file.
      for (const input of requested) {
        if (isAbsolute(input) || /^[A-Za-z]:/.test(input)) throw new Error('Paths must be relative to the workspace.')
        const path = workspaceRelative(root, resolve(root, input))
        if (path === undefined) throw new Error('Path escapes the workspace.')
        const key = fileKey(resolve(root, path))
        targets.set(key, { path, entry: files.get(key) })
      }
    }

    const softFiles: SoftRevertFile[] = []
    const revertId = randomUUID()

    for (const [key, { path, entry }] of targets) {
      if (!entry) {
        result.skipped.push({ path, reason: 'Cubex has not changed this file in this task.' })
        continue
      }
      const diskBefore = await readDisk(entry.path)
      const reason = await this.restore(conversationId, workspace, path, entry).catch(restoreFailure)
      if (reason) {
        result.skipped.push({ path, reason })
        continue
      }
      if (diskBefore.kind === 'file') {
        this.writeAtomic(join(this.directory(conversationId, true), 'blobs', diskBefore.hash), diskBefore.bytes)
      }
      softFiles.push({
        path,
        absPath: entry.path,
        preRevertHash: diskBefore.kind === 'file' ? diskBefore.hash : '',
        postRevertHash: entry.baseline ? entry.baseline.hash : '',
        existedBefore: diskBefore.kind === 'file',
        existedAfter: entry.baseline !== null,
        trackedEntry: { ...entry }
      })
      files.delete(key)
      result.restored.push(path)
      restoredFiles.push(entry.path)
    }

    if (restoredFiles.length) {
      result.revertId = revertId
      const softRecord: SoftRevertRecord = {
        id: revertId,
        conversationId,
        createdAt: Date.now(),
        files: softFiles,
        notes: result.restored.map((p) => ({ path: p, wholeFile: true }))
      }
      this.saveSoftRevert(conversationId, softRecord)
      raw.reviewNotes = raw.reviewNotes ?? {}
      raw.reviewNotes.reverts = raw.reviewNotes.reverts ?? []
      for (const p of result.restored) {
        raw.reviewNotes.reverts.push({ path: p, wholeFile: true, revertId })
      }
      this.commit(conversationId, files)
    }
    return { result, files: restoredFiles }
  }

  async undoRevert(conversationId: string, workspace: string, revertId: string): Promise<{ restored: string[] }> {
    if (!revertId || typeof revertId !== 'string' || !/^[a-f0-9-]{36}$/.test(revertId)) {
      throw new Error('Invalid revert id.')
    }
    const recordPath = join(this.directory(conversationId), 'reverts', `${revertId}.json`)
    if (!existsSync(recordPath)) {
      throw new Error('Revert record was not found or has expired.')
    }
    let record: SoftRevertRecord
    try {
      record = JSON.parse(readFileSync(recordPath, 'utf8')) as SoftRevertRecord
    } catch {
      throw new Error('Invalid soft revert record.')
    }

    const root = resolve(workspace)
    for (const f of record.files) {
      // The record is read back from disk: its word alone never lets Undo write or delete outside the workspace.
      if (typeof f.absPath !== 'string' || workspaceRelative(root, f.absPath) === undefined) {
        throw new Error(`File "${f.path}" is outside the workspace, so it was not restored.`)
      }
      const disk = await readDisk(f.absPath)
      if (f.existedAfter) {
        if (disk.kind !== 'file' || disk.hash !== f.postRevertHash) {
          throw new Error(`File "${f.path}" has changed since the revert.`)
        }
      } else {
        if (disk.kind !== 'absent') {
          throw new Error(`File "${f.path}" has changed since the revert.`)
        }
      }
    }

    // Read every saved copy first, so a missing one fails the undo before any file is touched.
    const saved = new Map<SoftRevertFile, Buffer>()
    for (const f of record.files) {
      if (!f.existedBefore) continue
      const bytes = this.readSaved(conversationId, f.preRevertHash)
      if (!bytes) throw new Error(`Saved content for "${f.path}" is missing or damaged.`)
      saved.set(f, bytes)
    }

    const files = this.load(conversationId)
    const raw = this.getRawIndex(conversationId)
    const restoredPaths: string[] = []

    for (const f of record.files) {
      const bytes = saved.get(f)
      if (bytes) await replaceFile(f.absPath, bytes)
      else if (existsSync(f.absPath)) await fs.unlink(f.absPath)
      if (f.trackedEntry) {
        // Tracked again exactly as before the revert, so a file edited elsewhere stays flagged and protected.
        files.set(fileKey(f.absPath), { ...f.trackedEntry, updatedAt: Date.now() })
      }
      if (f.acceptedHunkIds && raw.hunkStates) {
        for (const hId of f.acceptedHunkIds) {
          raw.hunkStates[hId] = { state: 'accepted', headHash: f.preRevertHash }
        }
      }
      restoredPaths.push(f.path)
    }

    unlinkSync(recordPath)

    if (raw.reviewNotes?.reverts) {
      raw.reviewNotes.reverts = raw.reviewNotes.reverts.filter((r) => r.revertId !== revertId)
    }
    this.commit(conversationId, files)

    return { restored: restoredPaths }
  }

  pendingReviewNotes(conversationId: string): string | undefined {
    this.load(conversationId)
    const raw = this.getRawIndex(conversationId)
    return raw.reviewNotes ? formatReviewNotes(raw.reviewNotes) : undefined
  }

  consumeReviewNotes(conversationId: string): string | undefined {
    const notes = this.pendingReviewNotes(conversationId)
    if (!notes) return undefined
    const files = this.load(conversationId)
    const raw = this.getRawIndex(conversationId)
    raw.reviewNotes = undefined
    this.save(conversationId, files)

    const revDir = join(this.directory(conversationId), 'reverts')
    if (existsSync(revDir)) rmSync(revDir, { recursive: true, force: true })
    this.cleanupBlobs(conversationId, files)
    return notes
  }

  /** Drop every baseline for a deleted task. */
  deleteConversation(conversationId: string): void {
    const key = taskKey(conversationId)
    this.indexes.delete(key)
    this.rawIndexes.delete(key)
    const dir = this.directory(conversationId)
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }

  private async describe(conversationId: string, entry: TrackedFile, path: string): Promise<SessionFileChange | undefined> {
    const disk = await readDisk(entry.path)
    if (sameContent(disk, entry.baseline)) return undefined
    const before = entry.baseline === null ? '' : entry.baseline.kept ? diffableText(this.readBlob(conversationId, entry.baseline)) : undefined
    const after = disk.kind === 'absent' ? '' : disk.kind === 'file' ? diffableText(disk.bytes) : undefined
    return {
      path,
      status: entry.baseline === null ? 'added' : disk.kind === 'absent' ? 'deleted' : 'modified',
      ...(before !== undefined && after !== undefined ? summarizeTextDiff(before, after) : { added: 0, removed: 0, diff: '' }),
      ...(!sameContent(disk, entry.latest) ? { externallyModified: true } : {}),
      updatedAt: entry.updatedAt
    }
  }

  /** Returns a skip reason, or undefined once the file is in its pre-task state. */
  private async restore(conversationId: string, workspace: string, path: string, entry: TrackedFile): Promise<string | undefined> {
    let parent: string
    try { parent = resolveWorkspacePath(workspace, dirname(path)) } catch { return 'Its folder was moved, removed, or replaced since Cubex edited it.' }
    const target = join(parent, basename(entry.path))
    if (!samePath(target, entry.location)) return 'Its folder was moved, removed, or replaced since Cubex edited it.'
    const disk = await readDisk(target)
    if (sameContent(disk, entry.baseline)) return undefined
    if (!sameContent(disk, entry.latest)) return EXTERNAL_EDIT_REASON
    if (entry.baseline === null) {
      await fs.unlink(target)
      return undefined
    }
    if (!entry.baseline.kept) {
      return entry.baseline.size > this.maxBaselineBytes
        ? 'Too large for Cubex to keep a restore point. Restore it from version control or a backup.'
        : 'No restore point was kept because this task reached its restore storage limit.'
    }
    const original = this.readBlob(conversationId, entry.baseline)
    if (!original) return 'Its saved original is missing or damaged.'
    await replaceFile(target, original)
    return undefined
  }

  /** Store the original bytes once per content hash, within the per-file and per-task budgets. */
  private keepBaseline(conversationId: string, files: Map<string, TrackedFile>, bytes: Buffer): ContentRef & { kept: boolean } {
    const ref = refOf(bytes)
    const stored = new Map<string, number>()
    for (const file of files.values()) if (file.baseline?.kept) stored.set(file.baseline.hash, file.baseline.size)
    if (stored.has(ref.hash)) return { ...ref, kept: true }
    let used = 0
    for (const size of stored.values()) used += size
    if (ref.size > this.maxBaselineBytes || used + ref.size > this.maxTaskBytes) return { ...ref, kept: false }
    this.writeAtomic(join(this.directory(conversationId, true), 'blobs', ref.hash), bytes)
    return { ...ref, kept: true }
  }

  private currentRef(path: string): ContentRef | null {
    try { return refOf(readFileSync(path)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  /** A stored original, verified against its hash; undefined when missing or damaged. */
  private readBlob(conversationId: string, ref: ContentRef): Buffer | undefined {
    try {
      const bytes = this.readChecked(join(this.directory(conversationId), 'blobs', ref.hash), this.maxBaselineBytes)
      return bytes.length === ref.size && (ref.size === 0 || sha256(bytes) === ref.hash) ? bytes : undefined
    } catch { return undefined }
  }

  /** What a revert replaced, verified against its hash; undefined when it is missing or damaged. */
  private readSaved(conversationId: string, hash: string): Buffer | undefined {
    if (!HASH.test(hash)) return undefined
    try {
      const bytes = this.readChecked(join(this.directory(conversationId), 'blobs', hash), MAX_COMPARE_BYTES)
      return sha256(bytes) === hash ? bytes : undefined
    } catch { return undefined }
  }

  private saveSoftRevert(conversationId: string, record: SoftRevertRecord): void {
    const dir = join(this.directory(conversationId, true), 'reverts')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.writeAtomic(join(dir, `${record.id}.json`), Buffer.from(JSON.stringify(record), 'utf8'))
  }

  private cleanupBlobs(conversationId: string, files: Map<string, TrackedFile>): void {
    const dir = this.directory(conversationId)
    const blobsDir = join(dir, 'blobs')
    if (!existsSync(blobsDir)) return
    const referenced = new Set<string>()
    for (const file of files.values()) {
      if (file.baseline?.kept) referenced.add(file.baseline.hash)
      if (file.turns) {
        for (const t of file.turns) {
          if (t.before?.kept) referenced.add(t.before.hash)
        }
      }
    }
    const revDir = join(dir, 'reverts')
    if (existsSync(revDir)) {
      for (const name of readdirSync(revDir)) {
        if (name.endsWith('.json')) {
          try {
            const rec = JSON.parse(readFileSync(join(revDir, name), 'utf8')) as SoftRevertRecord
            for (const f of rec.files) {
              if (f.preRevertHash) referenced.add(f.preRevertHash)
              if (f.trackedEntry?.baseline?.kept) referenced.add(f.trackedEntry.baseline.hash)
              if (f.trackedEntry?.turns) {
                for (const t of f.trackedEntry.turns) {
                  if (t.before?.kept) referenced.add(t.before.hash)
                }
              }
            }
          } catch {}
        }
      }
    }
    for (const name of readdirSync(blobsDir)) {
      const blob = join(blobsDir, name)
      if (HASH.test(name) && !referenced.has(name) && lstatSync(blob).isFile()) unlinkSync(blob)
    }
  }

  private load(conversationId: string): Map<string, TrackedFile> {
    const key = taskKey(conversationId)
    const cached = this.indexes.get(key)
    if (cached) return cached
    const files = new Map<string, TrackedFile>()
    const path = join(this.directory(conversationId), 'index.json')
    let rawIndex: TaskIndex = { version: 1, conversationId, files: [] }
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(this.readChecked(path, MAX_INDEX_BYTES).toString('utf8')) as Partial<TaskIndex>
        if (raw.version !== 1 || raw.conversationId !== conversationId || !Array.isArray(raw.files)) throw new Error('Invalid session change index.')
        for (const entry of raw.files) if (validEntry(entry)) files.set(fileKey(entry.path), entry)
        rawIndex = {
          version: 1,
          conversationId,
          files: [...files.values()],
          hunkStates: raw.hunkStates,
          hunks: raw.hunks,
          revision: raw.revision,
          currentTurnId: raw.currentTurnId,
          reviewNotes: raw.reviewNotes
        }
      } catch (error) { this.onError(error) }
    }
    this.indexes.set(key, files)
    this.rawIndexes.set(key, rawIndex)
    return files
  }

  private save(conversationId: string, files: Map<string, TrackedFile>): void {
    const key = taskKey(conversationId)
    const raw = this.getRawIndex(conversationId)
    const revDir = join(this.directory(conversationId), 'reverts')
    const hasReverts = existsSync(revDir) && readdirSync(revDir).length > 0
    if (!files.size && !hasReverts && !raw.hunkStates && !raw.reviewNotes) {
      const dir = this.directory(conversationId)
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
      this.indexes.delete(key)
      this.rawIndexes.delete(key)
      return
    }
    const dir = this.directory(conversationId, true)
    raw.files = [...files.values()]
    let body = Buffer.from(JSON.stringify(raw), 'utf8')
    // An index too big to read back would lose the task's changes at the next start. The hunks are only a cache, so they go first.
    if (body.length > MAX_INDEX_BYTES && raw.hunks) {
      raw.hunks = undefined
      body = Buffer.from(JSON.stringify(raw), 'utf8')
    }
    this.writeAtomic(join(dir, 'index.json'), body)
    this.cleanupBlobs(conversationId, files)
  }

  private directory(conversationId: string, create = false): string {
    const root = lstatSync(this.root)
    if (!root.isDirectory() || root.isSymbolicLink() || !samePath(realpathSync.native(this.root), this.root)) {
      throw new Error('Unsafe session change storage directory.')
    }
    const dir = join(this.root, taskKey(conversationId))
    for (const path of [dir, join(dir, 'blobs'), join(dir, 'reverts')]) {
      if (!existsSync(path)) {
        if (!create) break
        mkdirSync(path, { recursive: true })
      }
      const info = lstatSync(path)
      if (!info.isDirectory() || info.isSymbolicLink() || !samePath(realpathSync.native(path), path)) {
        throw new Error('Session change storage cannot contain links.')
      }
    }
    return dir
  }

  private readChecked(path: string, maxBytes: number): Buffer {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new Error('Invalid session change artifact.')
    return readFileSync(path)
  }

  private writeAtomic(path: string, data: Buffer): void {
    if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) {
      throw new Error('Invalid session change artifact destination.')
    }
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      const descriptor = openSync(temp, 'wx', 0o600)
      try {
        let written = 0
        while (written < data.length) written += writeSync(descriptor, data, written, data.length - written)
        fsyncSync(descriptor)
      } finally { closeSync(descriptor) }
      renameSync(temp, path)
    } finally { if (existsSync(temp)) unlinkSync(temp) }
  }
}
