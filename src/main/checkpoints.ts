import { randomUUID } from 'node:crypto'
import { promises as fs, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

interface Snapshot {
  turnSeq: number
  /** Absolute path of the file that was mutated. */
  path: string
  /** Exact bytes BEFORE the turn's first mutation of this path (binary-safe). */
  before: Buffer
  /** Whether the file existed before the turn (false = created during the turn). */
  existed: boolean
  /** Last successful tool-written contents; null means the file was removed. */
  after?: Buffer | null
  location: string
}

/** What restoring would do to one file: write the earlier content back, remove a file the turns created, or bring back one they removed. */
export type RestoreAction = 'revert' | 'delete' | 'recreate'

export interface CheckpointPreview {
  /** False when no checkpoint exists for the point: Cubex restarted since, or its turn had no file tools. */
  known: boolean
  /** Absolute paths a restore would change. */
  restorable: Array<{ path: string; action: RestoreAction }>
  /** Absolute paths a restore would leave alone, with why. */
  blocked: Array<{ path: string; reason: string }>
}

export interface CheckpointRestore {
  known: boolean
  /** Absolute paths that were put back. */
  restored: string[]
  /** Files left as they are because they changed outside Cubex. */
  skipped: Array<{ path: string; reason: string }>
  /** Files that could not be written. */
  failed: Array<{ path: string; reason: string }>
  /** Pass to `undo` until the next turn starts. Absent when nothing was restored. */
  undoId?: string
}

export interface CheckpointUndo {
  /** Absolute paths that went back to how the restore found them. */
  restored: string[]
  /** What each of those files held just before the undo and holds now (null: absent), for review tracking. */
  writes: Array<{ path: string; before: Buffer | null; after: Buffer | null }>
}

const REASON = {
  edited: 'Changed outside Cubex since its last edit',
  removed: 'Removed outside Cubex since its last edit',
  folder: 'Its folder was moved or replaced since the edit',
  type: 'It is no longer a regular file',
  unreadable: 'Cubex could not read it'
}

/** Never the raw error: it can carry paths and system wording the user cannot act on. */
function describeFailure(error: unknown): string {
  switch ((error as NodeJS.ErrnoException | undefined)?.code) {
    case 'EACCES': case 'EPERM': return 'Permission was denied'
    case 'EBUSY': return 'Another program is using it'
    case 'ENOSPC': return 'The disk is full'
    case 'EROFS': return 'The folder is read-only'
    case 'ENOENT': return 'Its folder no longer exists'
    case 'ELOCATION': return REASON.folder
    default: return 'It could not be written'
  }
}

const key = (path: string): string => (process.platform === 'win32' ? path.toLowerCase() : path)
const sameBytes = (a: Buffer | null, b: Buffer | null): boolean => (a === null ? b === null : b !== null && a.equals(b))
const landsAt = async (path: string, location: string): Promise<boolean> =>
  join(await fs.realpath(dirname(path)), basename(path)) === location
/** Thrown when a write would land somewhere other than where its snapshot was taken. */
const movedFolder = (): Error => Object.assign(new Error('The folder moved'), { code: 'ELOCATION' })

/** One file as a restore finds it: what was there before, what Cubex left, what is on disk now. */
interface FileState {
  first: Snapshot
  latest: Snapshot
  /** The bytes on disk now; null when the file is absent. */
  current: Buffer | null
  /** Set when the file differs from how a restore would leave it and may be touched. */
  action?: RestoreAction
  /** Set when a restore must leave the file alone. */
  blocked?: string
}

async function inspectFile(first: Snapshot, latest: Snapshot): Promise<FileState> {
  const refuse = (blocked: string): FileState => ({ first, latest, current: null, blocked })
  try {
    if (!(await landsAt(latest.path, latest.location))) return refuse(REASON.folder)
  } catch { return refuse(REASON.folder) }
  const target = first.existed ? first.before : null
  let current: Buffer | null = null
  try {
    const stat = await fs.lstat(latest.path)
    if (!stat.isFile() || stat.isSymbolicLink()) return refuse(REASON.type)
    // A size that matches neither known state already proves the file changed; skip reading a large one.
    if (latest.after !== undefined) {
      const known = [target?.length, latest.after?.length].filter((size): size is number => size !== undefined)
      if (!known.includes(stat.size)) return refuse(REASON.edited)
    }
    current = await fs.readFile(latest.path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return refuse(REASON.unreadable)
  }
  if (sameBytes(current, target)) return { first, latest, current }
  // Cubex's own last write must still be what is on disk, or someone else changed the file since.
  if (latest.after !== undefined && !sameBytes(current, latest.after)) return refuse(current === null ? REASON.removed : REASON.edited)
  return { first, latest, current, action: target === null ? 'delete' : current === null ? 'recreate' : 'revert' }
}

/** Whether a path still holds exactly the bytes a restore left (null: still absent). */
async function holds(path: string, location: string, bytes: Buffer | null): Promise<boolean> {
  try {
    if (!(await landsAt(path, location))) return false
    const stat = await fs.lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || bytes === null || stat.size !== bytes.length) return false
    return (await fs.readFile(path)).equals(bytes)
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' && bytes === null }
}

interface UndoRecord {
  id: string
  /** What the restore wrote and what it replaced, so the same bytes can go back. */
  files: Array<{ path: string; location: string; previous: Buffer | null; wrote: Buffer | null }>
  /** The snapshots the restore dropped, so the same point can be restored again after an undo. */
  dropped: Snapshot[]
}

/**
 * In-session file checkpoints for restore. Each turn gets a monotonic seq; the
 * first mutation of a path in a turn snapshots its prior content. Restoring to a
 * message puts back every file changed in that turn and all later ones — writing
 * the pre-turn content, or deleting files the agent created. A file that was
 * edited outside Cubex since is never overwritten. In-memory only (a safety net
 * within the running session), so restart clears it.
 */
export class CheckpointStore {
  private readonly log = new Map<string, Snapshot[]>()
  private readonly turnOf = new Map<string, Map<string, number>>()
  private readonly seq = new Map<string, number>()
  private readonly undoRecords = new Map<string, UndoRecord>()

  /** Open a new turn for a conversation, optionally tied to a user message id. */
  beginTurn(conversationId: string, messageId?: string): number {
    const next = (this.seq.get(conversationId) ?? 0) + 1
    this.seq.set(conversationId, next)
    if (messageId) {
      let m = this.turnOf.get(conversationId)
      if (!m) {
        m = new Map()
        this.turnOf.set(conversationId, m)
      }
      m.set(messageId, next)
    }
    // A new message ends the window in which the last restore can be undone.
    this.undoRecords.delete(conversationId)
    return next
  }

  /** Snapshot a file's pre-turn state (only the first mutation per path per turn). */
  record(conversationId: string, turnSeq: number, path: string, beforeInput: Buffer | string, existed: boolean, afterInput?: Buffer | string | null): void {
    const before = typeof beforeInput === 'string' ? Buffer.from(beforeInput, 'utf8') : beforeInput
    const after = typeof afterInput === 'string' ? Buffer.from(afterInput, 'utf8') : afterInput
    let arr = this.log.get(conversationId)
    if (!arr) {
      arr = []
      this.log.set(conversationId, arr)
    }
    const existing = arr.find((s) => s.turnSeq === turnSeq && s.path === path)
    if (existing) { existing.after = after; return }
    const location = join(realpathSync.native(dirname(path)), basename(path))
    arr.push({ turnSeq, path, before, existed, after, location })
  }

  /** How many distinct files were changed at/after the given message's turn. */
  countSince(conversationId: string, messageId: string): number {
    const turnSeq = this.turnOf.get(conversationId)?.get(messageId)
    if (turnSeq === undefined) return 0
    const arr = this.log.get(conversationId) ?? []
    return new Set(arr.filter((s) => s.turnSeq >= turnSeq).map((s) => s.path)).size
  }

  /**
   * The turn a restore starts from: that of the first message that began one. A message whose own turn
   * left no record (it ran without file tools) still has later turns to put back.
   */
  private turnFor(conversationId: string, messageIds: readonly string[]): number | undefined {
    const turns = this.turnOf.get(conversationId)
    for (const id of messageIds) {
      const seq = turns?.get(id)
      if (seq !== undefined) return seq
    }
    return undefined
  }

  /** Every file touched at or after a turn, with its earliest and latest snapshot, in the order first touched. */
  private async inspectSince(conversationId: string, turnSeq: number): Promise<FileState[]> {
    const byFile = new Map<string, { first: Snapshot; latest: Snapshot }>()
    for (const snapshot of this.log.get(conversationId) ?? []) {
      if (snapshot.turnSeq < turnSeq) continue
      const entry = byFile.get(key(snapshot.path))
      if (!entry) byFile.set(key(snapshot.path), { first: snapshot, latest: snapshot })
      else {
        if (snapshot.turnSeq < entry.first.turnSeq) entry.first = snapshot
        if (snapshot.turnSeq >= entry.latest.turnSeq) entry.latest = snapshot
      }
    }
    const states: FileState[] = []
    // One file at a time: a turn can touch hundreds, and each may be large.
    for (const { first, latest } of byFile.values()) states.push(await inspectFile(first, latest))
    return states
  }

  /** Write each file that needs it back. A failure never stops the others. */
  private async apply(states: FileState[]): Promise<{ done: FileState[]; failed: Array<{ path: string; reason: string }> }> {
    const done: FileState[] = []
    const failed: Array<{ path: string; reason: string }> = []
    for (const state of states) {
      if (!state.action) continue
      const { first } = state
      try {
        if (state.action === 'delete') await fs.rm(first.path, { force: true })
        else {
          // Re-check the parent right before writing: the restore must land where
          // the snapshot was taken, never through a since-swapped junction/symlink.
          if (!(await landsAt(first.path, first.location))) throw movedFolder()
          await fs.writeFile(first.path, first.before)
        }
        done.push(state)
      } catch (error) { failed.push({ path: first.path, reason: describeFailure(error) }) }
    }
    return { done, failed }
  }

  /** Forget the snapshots of files that no longer need rewinding; returns them so an undo can bring them back. */
  private drop(conversationId: string, turnSeq: number, states: FileState[]): Snapshot[] {
    const paths = new Set(states.map((state) => key(state.first.path)))
    const arr = this.log.get(conversationId) ?? []
    const dropped = new Set(arr.filter((s) => s.turnSeq >= turnSeq && paths.has(key(s.path))))
    this.log.set(conversationId, arr.filter((s) => !dropped.has(s)))
    return [...dropped]
  }

  /** What a restore to this point would change, without changing anything. `messageIds` run from the chosen message to the end. */
  async preview(conversationId: string, messageIds: readonly string[]): Promise<CheckpointPreview> {
    const turnSeq = this.turnFor(conversationId, messageIds)
    if (turnSeq === undefined) return { known: false, restorable: [], blocked: [] }
    const states = await this.inspectSince(conversationId, turnSeq)
    return {
      known: true,
      restorable: states.flatMap((state) => (state.action ? [{ path: state.first.path, action: state.action }] : [])),
      blocked: states.flatMap((state) => (state.blocked ? [{ path: state.latest.path, reason: state.blocked }] : []))
    }
  }

  /**
   * Put files back to how they were before this point. Files changed outside Cubex are skipped and
   * reported, never overwritten. Everything else is restored even when one file cannot be written.
   */
  async restore(conversationId: string, messageIds: readonly string[]): Promise<CheckpointRestore> {
    const turnSeq = this.turnFor(conversationId, messageIds)
    if (turnSeq === undefined) return { known: false, restored: [], skipped: [], failed: [] }
    const states = await this.inspectSince(conversationId, turnSeq)
    const { done, failed } = await this.apply(states)
    // Files now at their earlier state need no further rewinding, whether this restore wrote them or they already were.
    const dropped = this.drop(conversationId, turnSeq, [...done, ...states.filter((state) => !state.action && !state.blocked)])
    const result: CheckpointRestore = {
      known: true,
      restored: done.map((state) => state.first.path),
      skipped: states.flatMap((state) => (state.blocked ? [{ path: state.latest.path, reason: state.blocked }] : [])),
      failed
    }
    if (!done.length) return result
    const undoId = randomUUID()
    this.undoRecords.set(conversationId, {
      id: undoId,
      dropped,
      files: done.map((state) => ({
        path: state.first.path,
        location: state.first.location,
        previous: state.current,
        wrote: state.action === 'delete' ? null : state.first.before
      }))
    })
    return { ...result, undoId }
  }

  /** Undo the last restore of a conversation while its files still hold what the restore wrote. */
  async undo(conversationId: string, undoId: string): Promise<CheckpointUndo> {
    const record = this.undoRecords.get(conversationId)
    if (!record || record.id !== undoId) throw new Error('This restore can no longer be undone.')
    const changed: string[] = []
    for (const file of record.files) if (!(await holds(file.path, file.location, file.wrote))) changed.push(file.path)
    if (changed.length) throw new Error(`Undo stopped: these files changed after the restore. Your current files were preserved.\n${changed.join('\n')}`)

    const writes: CheckpointUndo['writes'] = []
    const failed: string[] = []
    for (const file of record.files) {
      try {
        if (file.previous === null) await fs.rm(file.path, { force: true })
        else {
          if (!(await landsAt(file.path, file.location))) throw movedFolder()
          await fs.writeFile(file.path, file.previous)
        }
        writes.push({ path: file.path, before: file.wrote, after: file.previous })
      } catch { failed.push(file.path) }
    }
    const restored = writes.map((write) => write.path)
    // The same point can be restored again, so its snapshots come back with the files.
    const back = new Set(restored.map(key))
    const log = this.log.get(conversationId) ?? []
    log.push(...record.dropped.filter((s) => back.has(key(s.path))))
    log.sort((a, b) => a.turnSeq - b.turnSeq)
    this.log.set(conversationId, log)
    record.files = record.files.filter((file) => failed.includes(file.path))
    record.dropped = record.dropped.filter((s) => !back.has(key(s.path)))
    if (!record.files.length) this.undoRecords.delete(conversationId)
    if (failed.length) throw new Error(`Undo restored ${restored.length} file(s), but could not restore:\n${failed.join('\n')}`)
    return { restored, writes }
  }

  /** Restore files to their state before the given message's turn, all or nothing (destructive, no undo). */
  async rewind(conversationId: string, messageId: string): Promise<{ restored: string[] }> {
    const turnSeq = this.turnOf.get(conversationId)?.get(messageId)
    if (turnSeq === undefined) return { restored: [] }
    // Validate every target before restoring any of them. A newer manual edit,
    // recreated file, or changed junction must never be silently overwritten.
    const states = await this.inspectSince(conversationId, turnSeq)
    const conflicts = states.filter((state) => state.blocked).map((state) => state.latest.path)
    if (conflicts.length) throw new Error(`Rewind stopped: these files changed after Cubex edited them or are unavailable. Your current files were preserved.\n${conflicts.join('\n')}`)
    const { done, failed } = await this.apply(states)
    // Retain failures for retry. Restored paths need no further rewinding.
    this.drop(conversationId, turnSeq, [...done, ...states.filter((state) => !state.action)])
    const restored = done.map((state) => state.first.path)
    if (failed.length) throw new Error(`Rewind restored ${restored.length} file(s), but could not restore:\n${failed.map((entry) => entry.path).join('\n')}\nThe conversation was kept. Retry after resolving the file access problem.`)
    return { restored }
  }

  /** Drop snapshots of files restored by other means (the review panel's undo), so a later rewind does not see them as conflicts. */
  forget(conversationId: string, paths: string[]): void {
    const dropped = new Set(paths.map(key))
    const arr = this.log.get(conversationId)
    if (arr) this.log.set(conversationId, arr.filter((s) => !dropped.has(key(s.path))))
  }

  clear(conversationId: string): void {
    this.log.delete(conversationId)
    this.turnOf.delete(conversationId)
    this.seq.delete(conversationId)
    this.undoRecords.delete(conversationId)
  }
}
