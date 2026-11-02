import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { PermissionMode } from '@shared/ipc'
import {
  DELEGATE_LIMITS, DELEGATE_TIMEOUT_MS, roleIsReadOnly,
  type AcpPeer, type DelegateActivity, type DelegateFile, type DelegateRole, type DelegateStep
} from '@shared/peers'
import { SESSION_BASELINE_MAX_BYTES } from '../sessionChanges'
import { AcpAgent, AcpFailure, type AcpAgentLike, type AcpEvent, type OpenOptions } from './acp/agent'
import { createDelegatePolicy, shownPath, type DelegateQuestion } from './acp/delegatePolicy'
import { canonicalPath } from './acp/permissions'
import { delegationPrompt } from './framing'
import { changesBetween, takeManifest } from './manifest'
import { cleanOutput, clipReply } from './output'

/**
 * One delegated task, from start to report. A fresh copy of the agent is started for it in the project folder, held to the
 * policy for what it asks about (`acp/delegatePolicy.ts`), given the task and nothing else, and stopped when it reports. The
 * folder is listed before and after, so that what it changed without asking is told too, and what it changed after Cubex
 * kept the original is handed back for Changes and Rewind.
 */

/** A file kept as it was before the agent changed it. */
export interface Captured {
  /** Absolute path. */
  path: string
  before: Buffer
  existed: boolean
}

export interface DelegateRequest {
  peer: AcpPeer
  task: string
  role: DelegateRole
  /** The project folder. The agent starts there and may change nothing outside it. */
  workspace: string
  /** The chat's permission mode now. It is read for every request the agent makes. */
  mode: () => PermissionMode
  signal?: AbortSignal
  ask: (question: DelegateQuestion) => Promise<boolean>
  isProtected: (relativePath: string) => boolean
  isReadOnlyCommand: (command: string) => boolean
  /** Told how the task is going, whenever a step starts or ends and while the agent waits for the person. */
  onUpdate?: (activity: DelegateActivity) => void
  timeoutMs?: number
  startTimeoutMs?: number
  env?: NodeJS.ProcessEnv
  /** Replaces the start of a real program. For tests. */
  open?: (options: OpenOptions) => Promise<AcpAgentLike>
}

export interface DelegateOutcome {
  status: 'done' | 'failed' | 'cancelled'
  /** What the agent said at the end, cleaned and clipped. Empty when it said nothing. */
  report: string
  error?: string
  hint?: string
  /** What the program itself printed when it failed. */
  output?: string
  /** The agent stopped early, and says why in a few words: what it did may be incomplete. */
  stoppedEarly?: string
  seconds: number
  steps: DelegateStep[]
  files: DelegateFile[]
  /** The files whose original Cubex kept and that did change, for review and rewind. */
  captured: Captured[]
  /** The project was too big to list in full: a file the agent changed without asking may be missing from `files`. */
  listingIncomplete: boolean
}

/** At most this often a card is told about progress, so a busy agent does not flood the window. */
const UPDATE_EVERY_MS = 300
/** The most of a report that is kept: a task's report is read by a model and then shown, not a transcript. */
const REPORT_CAP = 12_000

function key(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function stepsOf(map: Map<string, DelegateStep>): DelegateStep[] {
  const all = [...map.values()]
  return all.length <= DELEGATE_LIMITS.steps ? all : all.slice(all.length - DELEGATE_LIMITS.steps)
}

/** What a file holds now, or undefined when it is not there. A folder or a file too large to compare counts as unreadable. */
function readNow(path: string): Buffer | undefined | 'unreadable' {
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size > SESSION_BASELINE_MAX_BYTES) return 'unreadable'
    return readFileSync(path)
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ? undefined : 'unreadable'
  }
}

export async function runDelegation(request: DelegateRequest): Promise<DelegateOutcome> {
  const started = Date.now()
  const { peer, role } = request
  const readOnly = roleIsReadOnly(role)
  const root = canonicalPath(request.workspace) ?? request.workspace
  const captured = new Map<string, Captured>()
  const steps = new Map<string, DelegateStep>()
  let status: DelegateActivity['status'] = 'working'

  const relative = (path: string): string => shownPath(path, root)
  // The agent works in the project's real folder. Changes and Rewind compare files with the project as the chat spells it, which
  // differs when the project is reached through a link, a mapped drive or a short name, so what is handed back uses that spelling.
  const asCaller = (path: string): string => resolve(request.workspace, relative(path))
  const activity = (): DelegateActivity => ({
    name: peer.name,
    role,
    status,
    seconds: Math.round((Date.now() - started) / 1000),
    steps: stepsOf(steps),
    files: [...captured.values()].slice(0, DELEGATE_LIMITS.files).map((entry): DelegateFile => ({ path: relative(entry.path), change: entry.existed ? 'edited' : 'created', tracked: true }))
  })

  // Progress goes out at once, then at most a few times a second; the last word is always sent.
  let lastSent = 0
  let pending: ReturnType<typeof setTimeout> | undefined
  const send = (): void => {
    pending = undefined
    lastSent = Date.now()
    try { request.onUpdate?.(activity()) } catch { /* a card that fails to draw must not stop the task */ }
  }
  const update = (immediately = false): void => {
    if (!request.onUpdate) return
    const wait = lastSent + UPDATE_EVERY_MS - Date.now()
    if (immediately || wait <= 0) {
      clearTimeout(pending)
      send()
    } else if (!pending) pending = setTimeout(send, wait)
  }

  const capture = (paths: string[]): void => {
    for (const path of paths) {
      const absolute = isAbsolute(path) ? path : resolve(root, path)
      if (captured.has(key(absolute))) continue
      const now = readNow(absolute)
      if (now === 'unreadable') continue
      captured.set(key(absolute), { path: absolute, before: now ?? Buffer.alloc(0), existed: now !== undefined })
    }
  }

  const policy = createDelegatePolicy({
    root,
    agent: peer.name,
    mode: request.mode,
    readOnly,
    ask: async (question) => {
      status = 'waiting'
      update(true)
      try {
        return await request.ask(question)
      } finally {
        status = 'working'
        update(true)
      }
    },
    beforeChange: capture,
    isProtected: request.isProtected,
    isReadOnlyCommand: request.isReadOnlyCommand
  })

  const onEvent = (event: AcpEvent): void => {
    if (event.type !== 'step') return
    steps.set(event.id, { title: event.title, kind: event.kind, state: event.state })
    update()
  }

  const before = await takeManifest(root)
  let agent: AcpAgentLike | undefined
  let outcome: Pick<DelegateOutcome, 'status' | 'report' | 'error' | 'hint' | 'output' | 'stoppedEarly'>
  try {
    update(true)
    agent = await (request.open ?? ((options) => AcpAgent.open(options)))({
      peer,
      cwd: root,
      policy,
      ...(request.env ? { env: request.env } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.startTimeoutMs !== undefined ? { startTimeoutMs: request.startTimeoutMs } : {})
    })
    const reply = await agent.prompt(delegationPrompt(role, request.task), {
      ...(request.signal ? { signal: request.signal } : {}),
      timeoutMs: request.timeoutMs ?? DELEGATE_TIMEOUT_MS,
      onEvent
    })
    const report = clipReply(cleanOutput(reply.text), REPORT_CAP)
    if (reply.stopReason === 'refusal') {
      outcome = { status: 'failed', report, error: `${peer.name} declined the task.` }
    } else {
      const early = reply.stopReason === 'max_tokens' ? 'it ran out of room to answer' : reply.stopReason === 'max_turn_requests' ? 'it used all the steps it is allowed' : reply.capped ? 'its report was longer than what is kept' : undefined
      outcome = { status: 'done', report, ...(early ? { stoppedEarly: early } : {}) }
    }
  } catch (error) {
    if (request.signal?.aborted) {
      outcome = { status: 'cancelled', report: '', error: 'The task was cancelled.' }
    } else if (error instanceof AcpFailure) {
      outcome = { status: 'failed', report: '', error: error.message, ...(error.hint ? { hint: error.hint } : {}), ...(error.output ? { output: error.output } : {}) }
    } else {
      outcome = { status: 'failed', report: '', error: error instanceof Error ? error.message : String(error) }
    }
  } finally {
    if (agent) await agent.close().catch(() => undefined)
  }

  // What changed, from what Cubex kept and from the folder itself. What it kept is checked against the disk, because an
  // agent may have been allowed to change a file and not have changed it.
  const after = await takeManifest(root)
  const files = new Map<string, DelegateFile>()
  const changed: Captured[] = []
  for (const entry of captured.values()) {
    const now = readNow(entry.path)
    if (now === 'unreadable') {
      files.set(key(relative(entry.path)), { path: relative(entry.path), change: 'edited', tracked: false })
      continue
    }
    const change: DelegateFile['change'] | undefined = !entry.existed ? (now === undefined ? undefined : 'created') : now === undefined ? 'deleted' : now.equals(entry.before) ? undefined : 'edited'
    if (!change) continue
    files.set(key(relative(entry.path)), { path: relative(entry.path), change, tracked: true })
    changed.push(entry)
  }
  // A file Cubex kept is judged by what it holds, which is more exact than the listing: an agent may have been allowed to
  // rewrite a file and written the same thing, and the listing would still see a newer time.
  const judged = new Set([...captured.values()].map((entry) => key(relative(entry.path))))
  for (const found of changesBetween(before, after)) if (!files.has(key(found.path)) && !judged.has(key(found.path))) files.set(key(found.path), { path: found.path, change: found.change, tracked: false })

  status = outcome.status
  // An update still waiting for its turn goes out now, so the last word the card has is the last word there is.
  const waiting = pending !== undefined
  clearTimeout(pending)
  if (waiting) send()
  return {
    ...outcome,
    seconds: Math.round((Date.now() - started) / 1000),
    steps: stepsOf(steps),
    files: [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).slice(0, DELEGATE_LIMITS.files),
    captured: changed.map((entry) => ({ ...entry, path: asCaller(entry.path) })),
    listingIncomplete: !before.complete || !after.complete
  }
}
