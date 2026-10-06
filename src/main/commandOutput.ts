import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { CommandOutputArtifact, CommandOutputPage } from '@shared/ipc'
export type { CommandOutputArtifact, CommandOutputPage } from '@shared/ipc'

export const COMMAND_OUTPUT_MAX_BYTES = 2 * 1024 * 1024
export const COMMAND_OUTPUT_MAX_ARTIFACTS = 50
export const COMMAND_OUTPUT_DEFAULT_PAGE_BYTES = 16 * 1024
export const COMMAND_OUTPUT_MAX_PAGE_BYTES = 64 * 1024
const MAX_METADATA_BYTES = 32 * 1024
const OUTPUT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const STATUSES = ['running', 'completed', 'failed', 'cancelled', 'timed_out', 'interrupted'] as const

export interface CommandOutputCompletion {
  status: Exclude<CommandOutputArtifact['status'], 'running'>
  exitCode?: number
  signal?: string
  error?: string
}

export interface CommandOutputWriter {
  readonly id: string
  readonly artifact: CommandOutputArtifact
  append(text: string): void
  finish(result: CommandOutputCompletion): CommandOutputArtifact
}

function taskKey(conversationId: string): string {
  if (typeof conversationId !== 'string' || !conversationId.trim() || conversationId.length > 256) throw new Error('A valid task id is required for saved command output.')
  return createHash('sha256').update(conversationId).digest('hex').slice(0, 32)
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function integer(value: unknown, min = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min
}

/** Durable task-owned UTF-8 output. Only generated IDs ever become filenames. */
export class CommandOutputStore {
  private readonly root: string
  private readonly active = new Map<string, CommandOutputWriter>()
  private lastCreatedAt = 0

  constructor(root: string) {
    const path = resolve(root)
    mkdirSync(path, { recursive: true })
    if (lstatSync(path).isSymbolicLink()) throw new Error('Command output storage cannot be a symbolic link.')
    this.root = realpathSync.native(path)
  }

  create(conversationId: string, input: { command: string }): CommandOutputWriter {
    if (typeof input?.command !== 'string' || !input.command.trim()) throw new Error('A command is required for saved output.')
    const directory = this.directory(conversationId, true)
    this.makeRoom(conversationId, directory)
    const id = randomUUID()
    const path = join(directory, `${id}.log`)
    const metadataPath = join(directory, `${id}.json`)
    const fd = openSync(path, 'wx', 0o600)
    let state: CommandOutputArtifact = {
      id, conversationId, command: input.command.slice(0, 4096),
      createdAt: Math.max(Date.now(), this.lastCreatedAt + 1), status: 'running',
      capturedBytes: 0, totalBytes: 0, truncated: false
    }
    this.lastCreatedAt = state.createdAt
    try { this.atomicMetadata(metadataPath, state) } catch (error) {
      closeSync(fd)
      unlinkSync(path)
      throw error
    }
    let finished = false
    let captureError: string | undefined
    const writer: CommandOutputWriter = {
      id,
      get artifact() { return { ...state } },
      append: (text) => {
        if (finished) throw new Error('This command output is already closed.')
        const totalBytes = Buffer.byteLength(text, 'utf8')
        state.totalBytes = Math.min(Number.MAX_SAFE_INTEGER, (state.totalBytes ?? 0) + totalBytes)
        if (state.truncated || captureError) return
        const data = Buffer.allocUnsafe(Math.min(totalBytes, COMMAND_OUTPUT_MAX_BYTES - state.capturedBytes))
        // Buffer.write preserves UTF-8 boundaries and never allocates beyond the cap.
        const length = data.write(text, 'utf8')
        try {
          let written = 0
          while (written < length) {
            const count = writeSync(fd, data, written, length - written)
            if (!count) throw new Error('The output file stopped accepting data.')
            written += count
            state.capturedBytes += count
          }
        } catch (error) {
          captureError = `Output capture stopped: ${(error as Error).message}`.slice(0, 1000)
        }
        if (length < totalBytes || captureError) {
          state.truncated = true
          // Persist the fact that bytes were dropped, even if Cubex later exits
          // before the final receipt. Further output only updates counters in RAM.
          try { this.atomicMetadata(metadataPath, state) } catch (error) { captureError ??= `Capture receipt could not be saved: ${(error as Error).message}`.slice(0, 1000) }
        }
      },
      finish: (result) => {
        if (finished) return { ...state }
        if (!result || !STATUSES.includes(result.status) || result.status === ('running' as string)) throw new Error('Invalid command output completion status.')
        finished = true
        try { fsyncSync(fd) } catch (error) { captureError ??= `Output could not be flushed: ${(error as Error).message}`.slice(0, 1000) }
        try { closeSync(fd) } catch (error) { captureError ??= `Output could not be closed: ${(error as Error).message}`.slice(0, 1000) }
        state = {
          ...state, status: result.status, completedAt: Date.now(),
          ...(typeof result.exitCode === 'number' && Number.isInteger(result.exitCode) ? { exitCode: result.exitCode } : {}),
          ...(typeof result.signal === 'string' ? { signal: result.signal.slice(0, 64) } : {}),
          ...(result.error || captureError ? { error: [result.error, captureError].filter(Boolean).join('\n').slice(0, 2000) } : {})
        }
        try {
          this.directory(conversationId)
          this.atomicMetadata(metadataPath, state)
        } finally { this.active.delete(id) }
        return { ...state }
      }
    }
    this.active.set(id, writer)
    return writer
  }

  get(conversationId: string, id: string): CommandOutputArtifact | null {
    const directory = this.directory(conversationId)
    this.validateId(id)
    const metadataPath = join(directory, `${id}.json`)
    if (!existsSync(metadataPath)) return null
    const raw = JSON.parse(this.readBounded(metadataPath, MAX_METADATA_BYTES).toString('utf8')) as CommandOutputArtifact
    if (!raw || raw.id !== id || raw.conversationId !== conversationId || typeof raw.command !== 'string' || raw.command.length > 4096 ||
      !integer(raw.createdAt) || !STATUSES.includes(raw.status) || !integer(raw.capturedBytes) || raw.capturedBytes > COMMAND_OUTPUT_MAX_BYTES ||
      typeof raw.truncated !== 'boolean' || (raw.totalBytes !== undefined && (!integer(raw.totalBytes) || raw.totalBytes < raw.capturedBytes)) ||
      (raw.completedAt !== undefined && !integer(raw.completedAt)) || (raw.exitCode !== undefined && !Number.isInteger(raw.exitCode)) ||
      (raw.signal !== undefined && (typeof raw.signal !== 'string' || raw.signal.length > 64)) ||
      (raw.error !== undefined && (typeof raw.error !== 'string' || raw.error.length > 2000))) throw new Error('Invalid saved command output metadata.')
    const path = join(directory, `${id}.log`)
    const file = this.checkedFile(path, COMMAND_OUTPUT_MAX_BYTES)
    const running = this.active.get(id)
    if (running) {
      const current = running.artifact
      if (current.conversationId !== conversationId || current.capturedBytes !== file.size) throw new Error('Saved command output does not match its active capture.')
      return current
    }
    if (raw.status === 'running') {
      const recovered: CommandOutputArtifact = {
        id, conversationId, command: raw.command, createdAt: raw.createdAt,
        status: 'interrupted', capturedBytes: file.size, truncated: raw.truncated,
        error: 'Capture was interrupted. Only the saved prefix is available; the original output length is unknown.'
      }
      // A full/read-only disk may be why the final receipt was never written.
      // Recovery must not make already-saved output depend on another write.
      try { this.atomicMetadata(metadataPath, recovered) } catch { /* Read the durable prefix without repairing the receipt. */ }
      return recovered
    }
    if (raw.capturedBytes !== file.size) throw new Error('Saved command output does not match its receipt.')
    return {
      id, conversationId, command: raw.command, createdAt: raw.createdAt, status: raw.status,
      capturedBytes: raw.capturedBytes, truncated: raw.truncated,
      ...(raw.totalBytes !== undefined ? { totalBytes: raw.totalBytes } : {}),
      ...(raw.completedAt !== undefined ? { completedAt: raw.completedAt } : {}),
      ...(raw.exitCode !== undefined ? { exitCode: raw.exitCode } : {}),
      ...(raw.signal !== undefined ? { signal: raw.signal } : {}),
      ...(raw.error !== undefined ? { error: raw.error } : {})
    }
  }

  list(conversationId: string): CommandOutputArtifact[] {
    const directory = this.directory(conversationId)
    if (!existsSync(directory)) return []
    const artifacts: CommandOutputArtifact[] = []
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.json') || !OUTPUT_ID.test(name.slice(0, -5))) continue
      try {
        const artifact = this.get(conversationId, name.slice(0, -5))
        if (artifact) artifacts.push(artifact)
      } catch { /* A damaged receipt must not block the other command outputs. */ }
    }
    return artifacts.sort((a, b) => b.createdAt - a.createdAt)
  }

  read(conversationId: string, id: string, options: { offset?: number; limit?: number } = {}): CommandOutputPage | null {
    const offset = options.offset ?? 0
    const limit = options.limit ?? COMMAND_OUTPUT_DEFAULT_PAGE_BYTES
    if (!integer(offset) || !integer(limit, 4) || limit > COMMAND_OUTPUT_MAX_PAGE_BYTES) throw new Error('Output offset must be a non-negative byte offset; limit must be 4–65536 bytes.')
    const artifact = this.get(conversationId, id)
    if (!artifact) return null
    const { fd, size } = this.openChecked(join(this.directory(conversationId), `${id}.log`), COMMAND_OUTPUT_MAX_BYTES)
    try {
      if (offset > size) throw new Error('Output offset is beyond the saved output.')
      // One look-ahead byte is enough to detect whether the page ends inside a
      // code point. Reading pages never loads the entire saved log into memory.
      const data = Buffer.alloc(Math.min(limit + 1, size - offset))
      let length = 0
      while (length < data.length) {
        const count = readSync(fd, data, length, data.length - length, offset + length)
        if (!count) throw new Error('Saved command output changed while reading the page.')
        length += count
      }
      if (data.length && (data[0]! & 0xc0) === 0x80) throw new Error('Output offset splits a UTF-8 character. Use the previous page’s nextOffset.')
      let end = Math.min(limit, data.length)
      while (end > 0 && end < data.length && (data[end]! & 0xc0) === 0x80) end--
      const next = offset + end
      return { artifact, text: data.subarray(0, end).toString('utf8'), offset, ...(next < size ? { nextOffset: next } : {}), eof: next === size }
    } finally { closeSync(fd) }
  }

  revealPath(conversationId: string, id: string): string {
    if (!this.get(conversationId, id)) throw new Error('No matching saved command output exists in this task.')
    return join(this.directory(conversationId), `${id}.log`)
  }

  /** Remove every saved output for a deleted conversation. Active captures are left to finish. */
  deleteConversation(conversationId: string): void {
    for (const writer of this.active.values()) if (writer.artifact.conversationId === conversationId) return
    const directory = this.directory(conversationId)
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true })
  }

  private validateId(id: string): void {
    if (typeof id !== 'string' || !OUTPUT_ID.test(id)) throw new Error('Invalid command output id; use an output ID, never a path.')
  }

  private directory(conversationId: string, create = false): string {
    const root = lstatSync(this.root)
    if (!root.isDirectory() || root.isSymbolicLink() || !samePath(realpathSync.native(this.root), this.root)) throw new Error('Unsafe command output storage directory.')
    const directory = join(this.root, taskKey(conversationId))
    if (create) mkdirSync(directory, { recursive: true })
    if (existsSync(directory)) {
      const info = lstatSync(directory)
      if (!info.isDirectory() || info.isSymbolicLink() || !samePath(realpathSync.native(directory), directory)) throw new Error('Command output task directory cannot be a link.')
    }
    return directory
  }

  private checkedFile(path: string, maximum: number) {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maximum) throw new Error('Unsafe or oversized command output file.')
    return info
  }

  private readBounded(path: string, maximum: number): Buffer {
    const { fd } = this.openChecked(path, maximum)
    try {
      const bytes = Buffer.alloc(maximum + 1)
      let length = 0
      while (length < bytes.length) {
        const read = readSync(fd, bytes, length, bytes.length - length, length)
        if (!read) break
        length += read
      }
      if (length > maximum) throw new Error('Saved command output exceeds its size limit.')
      return bytes.subarray(0, length)
    } finally { closeSync(fd) }
  }

  private openChecked(path: string, maximum: number): { fd: number; size: number } {
    const info = this.checkedFile(path, maximum)
    const fd = openSync(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW))
    try {
      const opened = fstatSync(fd)
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== info.dev || opened.ino !== info.ino || opened.size > maximum) throw new Error('Command output changed while it was opened.')
      return { fd, size: opened.size }
    } catch (error) {
      closeSync(fd)
      throw error
    }
  }

  private atomicMetadata(path: string, metadata: CommandOutputArtifact): void {
    if (existsSync(path)) this.checkedFile(path, MAX_METADATA_BYTES)
    const data = Buffer.from(JSON.stringify(metadata), 'utf8')
    if (data.length > MAX_METADATA_BYTES) throw new Error('Command output metadata is too large.')
    const temporary = `${path}.${randomUUID()}.tmp`
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      try {
        let written = 0
        while (written < data.length) {
          const count = writeSync(fd, data, written, data.length - written)
          if (!count) throw new Error('The output receipt stopped accepting data.')
          written += count
        }
        fsyncSync(fd)
      } finally { closeSync(fd) }
      renameSync(temporary, path)
    } finally { if (existsSync(temporary)) unlinkSync(temporary) }
  }

  private makeRoom(conversationId: string, directory: string): void {
    const ids = [...new Set(readdirSync(directory).filter((name) => /\.(?:log|json)$/.test(name) && OUTPUT_ID.test(name.replace(/\.(?:log|json)$/, ''))).map((name) => name.replace(/\.(?:log|json)$/, '')))]
    if (ids.length < COMMAND_OUTPUT_MAX_ARTIFACTS) return
    const candidates: Array<{ id: string; createdAt: number }> = []
    for (const id of ids) {
      if (this.active.has(id)) continue
      try {
        // Only generated, regular, singly-linked files can be pruned. Damaged
        // JSON is not a reason to block future commands or exceed retention.
        const times = ['log', 'json'].flatMap((extension) => {
          const path = join(directory, `${id}.${extension}`)
          return existsSync(path) ? [this.checkedFile(path, extension === 'log' ? COMMAND_OUTPUT_MAX_BYTES : MAX_METADATA_BYTES).mtimeMs] : []
        })
        let createdAt = Math.min(...times)
        try { createdAt = this.get(conversationId, id)?.createdAt ?? createdAt } catch { /* Prune safe files using their actual age. */ }
        candidates.push({ id, createdAt })
      } catch { /* Unsafe links are never followed or deleted to make room. */ }
    }
    candidates.sort((a, b) => a.createdAt - b.createdAt)
    while (ids.length >= COMMAND_OUTPUT_MAX_ARTIFACTS) {
      const oldest = candidates.shift()
      if (!oldest) throw new Error('This task has no removable command-output captures; the 50-artifact retention limit was reached.')
      for (const extension of ['log', 'json']) {
        const path = join(directory, `${oldest.id}.${extension}`)
        if (existsSync(path)) {
          this.checkedFile(path, extension === 'log' ? COMMAND_OUTPUT_MAX_BYTES : MAX_METADATA_BYTES)
          unlinkSync(path)
        }
      }
      ids.pop()
    }
  }
}
