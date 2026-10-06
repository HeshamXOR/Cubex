import type { WorkspacePathStat } from '../../../shared/workspaceFile'

interface PathCheckerOptions {
  stat: (paths: string[], conversationId: string | undefined) => Promise<WorkspacePathStat[]>
  now?: () => number
  /** How long to gather paths into one request. */
  batchMs?: number
}

/** A file stays "found" for a minute; a miss is rechecked sooner, because the agent may create the file any moment. */
export const FOUND_TTL_MS = 60_000
export const MISSING_TTL_MS = 10_000
const FAILED_TTL_MS = 2_000
const BATCH_SIZE = 40

interface Entry {
  at: number
  ttl: number
  stat: WorkspacePathStat
}

interface Waiting {
  conversationId: string | undefined
  /** path -> everyone waiting for it */
  paths: Map<string, Array<(stat: WorkspacePathStat) => void>>
}

const MISSING: WorkspacePathStat = { kind: 'missing' }

/**
 * Asks the main process whether the paths seen in a conversation exist, a batch at a time, and
 * remembers the answers. Many inline `code` spans on one screen cost one request, and the same
 * path costs one request however often it appears.
 */
export class PathChecker {
  private readonly cache = new Map<string, Entry>()
  private readonly waiting = new Map<string, Waiting>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly now: () => number
  private readonly batchMs: number

  constructor(private readonly options: PathCheckerOptions) {
    this.now = options.now ?? Date.now
    this.batchMs = options.batchMs ?? 12
  }

  /** The remembered answer, if it is still fresh. `scope` names the workspace the paths belong to. */
  peek(scope: string, path: string): WorkspacePathStat | undefined {
    const key = `${scope}\0${path}`
    const entry = this.cache.get(key)
    if (!entry) return undefined
    if (this.now() - entry.at >= entry.ttl) {
      this.cache.delete(key)
      return undefined
    }
    return entry.stat
  }

  check(scope: string, conversationId: string | undefined, path: string): Promise<WorkspacePathStat> {
    const known = this.peek(scope, path)
    if (known) return Promise.resolve(known)
    return new Promise((resolve) => {
      let group = this.waiting.get(scope)
      if (!group) {
        group = { conversationId, paths: new Map() }
        this.waiting.set(scope, group)
      }
      const listeners = group.paths.get(path)
      if (listeners) listeners.push(resolve)
      else group.paths.set(path, [resolve])
      this.timer ??= setTimeout(() => this.flush(), this.batchMs)
    })
  }

  clear(): void {
    this.cache.clear()
  }

  private flush(): void {
    this.timer = undefined
    const groups = [...this.waiting.entries()]
    this.waiting.clear()
    for (const [scope, group] of groups) {
      const paths = [...group.paths.keys()]
      for (let from = 0; from < paths.length; from += BATCH_SIZE) {
        const slice = paths.slice(from, from + BATCH_SIZE)
        void this.options.stat(slice, group.conversationId).then(
          (stats) => this.settle(scope, group, slice, (index) => stats[index] ?? MISSING, false),
          () => this.settle(scope, group, slice, () => MISSING, true)
        )
      }
    }
  }

  private settle(scope: string, group: Waiting, paths: string[], answer: (index: number) => WorkspacePathStat, failed: boolean): void {
    paths.forEach((path, index) => {
      const stat = answer(index)
      const ttl = failed ? FAILED_TTL_MS : stat.kind === 'missing' ? MISSING_TTL_MS : FOUND_TTL_MS
      this.cache.set(`${scope}\0${path}`, { at: this.now(), ttl, stat })
      for (const resolve of group.paths.get(path) ?? []) resolve(stat)
    })
  }
}
