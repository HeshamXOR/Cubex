import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ModePurpose } from './modes'

/**
 * What Cubex answers when an agent asks permission to use one of its tools, session/request_permission. A consulted
 * agent may look, and nothing else: reading, searching and thinking are allowed inside the folder it was started in,
 * and every other kind of tool, editing, deleting, moving, running a command, fetching a page, changing the mode,
 * anything not named, is refused. The answer is always a choice the agent itself offered, and it is never one that is
 * remembered: "always allow" would be written to the agent's settings, which are the person's own.
 */

/** A reply to session/request_permission: the agent's own option, or a cancel when it offered no fitting one. */
export type PermissionReply = { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }

export interface PermissionDecision {
  allow: boolean
  reply: PermissionReply
  /** For the log: what was decided, in a few words. */
  reason: string
}

const READING = new Set(['read', 'search', 'think'])

export interface Option {
  optionId: string
  kind: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function permissionOptions(value: unknown): Option[] {
  if (!Array.isArray(value)) return []
  const out: Option[] = []
  for (const entry of value) {
    if (isRecord(entry) && typeof entry.optionId === 'string' && typeof entry.kind === 'string') out.push({ optionId: entry.optionId, kind: entry.kind })
  }
  return out
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

/**
 * The real path of something that may not exist yet: the real path of the deepest part that does, then the rest. A
 * path that exists but cannot be resolved, such as a broken link, is not trusted. The path is not tidied first: with a
 * link in it, "link/.." is not where it looks.
 */
export function canonicalPath(path: string): string | undefined {
  let candidate = path
  const rest: string[] = []
  for (;;) {
    try {
      return resolve(realpathSync.native(candidate), ...rest)
    } catch (error) {
      if (!isMissing(error)) return undefined
    }
    try {
      lstatSync(candidate)
      return undefined
    } catch (error) {
      if (!isMissing(error)) return undefined
    }
    const parent = dirname(candidate)
    if (parent === candidate) return undefined
    rest.unshift(basename(candidate))
    candidate = parent
  }
}

/** Whether a path, as the agent wrote it, ends up inside the folder once links are followed. */
export function isInside(path: string, root: string): boolean {
  const base = canonicalPath(root)
  if (!base) return false
  const target = canonicalPath(isAbsolute(path) ? path : `${root}${root.endsWith(sep) ? '' : sep}${path}`)
  if (!target) return false
  const between = relative(base, target)
  return between === '' || (between !== '..' && !between.startsWith(`..${sep}`) && !isAbsolute(between))
}

function judge(kind: string, locations: unknown, root: string): { allow: boolean; reason: string } {
  if (!READING.has(kind)) return { allow: false, reason: `a tool of kind "${kind}" is not allowed in a consultation` }
  if (!Array.isArray(locations)) return { allow: true, reason: `${kind} without a place` }
  for (const location of locations) {
    const path = isRecord(location) ? location.path : undefined
    if (typeof path !== 'string' || !path) return { allow: false, reason: 'a place that is not a path' }
    if (!isInside(path, root)) return { allow: false, reason: 'a place outside the folder the agent was started in' }
  }
  return { allow: true, reason: `${kind} inside the folder` }
}

/**
 * How a session answers its agent: which kind of mode fits the job, and what to say to a permission request. A
 * consultation answers by the rule above. A delegated task answers by the chat's permission mode and may ask the person,
 * so the answer can take a while.
 */
export interface AcpPolicy {
  purpose: ModePurpose
  decide(params: unknown): PermissionReply | Promise<PermissionReply>
}

/**
 * Allow this once, or refuse this once, with the agent's own option for it. Never "always": that would be written into the
 * agent's own settings, which are the person's. `honoured` is false when the agent offered no option for the answer, which
 * is then a cancel, and a cancel is a refusal.
 */
export function replyOnce(offered: readonly Option[], allow: boolean): { reply: PermissionReply; honoured: boolean } {
  const wanted = offered.find((option) => option.kind === (allow ? 'allow_once' : 'reject_once'))
  if (wanted) return { reply: { outcome: { outcome: 'selected', optionId: wanted.optionId } }, honoured: true }
  return { reply: { outcome: { outcome: 'cancelled' } }, honoured: false }
}

/** The policy of a consultation: look inside the folder and answer, nothing else. */
export function consultPolicy(root: string): AcpPolicy {
  return { purpose: 'consult', decide: (params) => decidePermission(params, root).reply }
}

/** The answer to one permission request. `root` is the folder the session was started in. */
export function decidePermission(params: unknown, root: string): PermissionDecision {
  const request = isRecord(params) ? params : {}
  const offered = permissionOptions(request.options)
  const toolCall = isRecord(request.toolCall) ? request.toolCall : {}
  const kind = typeof toolCall.kind === 'string' ? toolCall.kind : 'other'
  const verdict = judge(kind, toolCall.locations, root)

  if (verdict.allow) {
    const once = offered.find((option) => option.kind === 'allow_once')
    if (once) return { allow: true, reply: { outcome: { outcome: 'selected', optionId: once.optionId } }, reason: verdict.reason }
    return { allow: false, reply: { outcome: { outcome: 'cancelled' } }, reason: 'the agent offered no way to allow this once' }
  }
  const no = offered.find((option) => option.kind === 'reject_once')
  return { allow: false, reply: no ? { outcome: { outcome: 'selected', optionId: no.optionId } } : { outcome: { outcome: 'cancelled' } }, reason: verdict.reason }
}
