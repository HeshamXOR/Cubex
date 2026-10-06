import { isAbsolute, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { DiagnosticItem, DiagnosticsStatus } from '@shared/ipc'
import { buildReport, newDiagnostics } from './deltas'
import { pathKey, sourceKind } from './paths'
import { findProjectConfig } from './projectConfig'
import { probeTypeScript } from './tsHost'
import type { CheckOutcome, WorkerInit, WorkerRequest, WorkerResponse } from './tsProtocol'
import type {
  BackendCheckRequest,
  DiagnoseHook,
  Diagnostic,
  DiagnosticsBackend,
  DiagnosticsReport,
  FileCheck,
  MutatedFile
} from './types'
import { findAppDir, resolveWorkerPath } from './workerPath'

export interface DiagnosticsTimeouts {
  /** One request to a warm checker. */
  requestMs: number
  /** The first request of a session, which pays for parsing the whole project. */
  coldMs: number
  /** Everything one edit may wait for, across every file it changed. */
  hookMs: number
  /** How long a request that was given up on may keep the worker busy before the worker is replaced. */
  stuckMs: number
  /** A workspace nobody has asked about this long gives its worker back. */
  idleMs: number
}

const DEFAULT_TIMEOUTS: DiagnosticsTimeouts = {
  requestMs: 6_000,
  coldMs: 20_000,
  hookMs: 25_000,
  stuckMs: 10_000,
  idleMs: 10 * 60_000
}

export interface DiagnosticsManagerOptions {
  /** Where an app-installed typescript is looked for when the workspace has none. Defaults to the app folder. */
  appDir?: string
  /** The built worker script. Defaults to the one beside the main bundle. */
  workerPath?: string
  timeouts?: Partial<DiagnosticsTimeouts>
}

/** A worker that keeps dying is left alone: this many failures end its session until it idles out. */
const MAX_WORKER_FAILURES = 3
/** After the first failure the worker restarts at once; after later ones it waits this long. */
const RESTART_AFTER_MS = 30_000
/** How long what was learned about a workspace (config found, typescript found) is trusted. */
const PLAN_TTL_MS = 5_000
/** Problems returned by one getDiagnostics call, and files it visits when no path is given. */
const MAX_ITEMS = 500
const MAX_TRACKED_FILES = 50

const WORKER_MISSING_REASON =
  'The type checker (tsWorker.js) is missing from this build of Cubex, so errors are not checked after edits. Rebuild or reinstall the app to restore it.'
const NO_CONFIG_REASON =
  'This folder has no tsconfig.json or jsconfig.json, so errors are not checked after edits. Add a tsconfig.json to this folder to turn it on.'

function strictUtf8(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return undefined
  }
}

function toItem(d: Diagnostic): DiagnosticItem {
  return {
    path: d.path,
    line: d.line,
    col: d.col,
    ...(d.code ? { code: d.code } : {}),
    ...(d.severity === 'warning' ? { severity: 'warning' as const } : {}),
    message: d.message
  }
}

interface Job {
  build: (id: number) => WorkerRequest
  resolve: (outcome: CheckOutcome) => void
  settled: boolean
  signal?: AbortSignal
  onAbort?: () => void
}

interface Inflight {
  id: number
  job: Job
  timer: NodeJS.Timeout
  /** Set once the request was given up on while the worker was still running it. */
  stuck?: NodeJS.Timeout
}

interface RootSession {
  root: string
  worker?: Worker
  /** One Int32 cell shared with the worker: the id of a request to stop, see WorkerInit.cancel. */
  cancelBuffer: SharedArrayBuffer
  cancel: Int32Array
  nextId: number
  queue: Job[]
  inflight?: Inflight
  idleTimer?: NodeJS.Timeout
  status: DiagnosticsStatus
  version: string
  /** Requests the worker has answered; until one has, the program is not built and a request may take long. */
  answered: number
  failures: number
  lastFailureAt: number
}

type Plan = { ok: true; version: string } | { ok: false; status: DiagnosticsStatus }

/**
 * The one place that runs the compiler. A project's program is built and checked in a worker thread (one per
 * workspace, started on demand, gone after ten idle minutes), because doing it on the main thread would freeze
 * the window. Requests to a worker run one at a time, and each is timed from the moment the worker starts it.
 * Every method that cannot give an answer resolves to undefined or an empty list rather than to a guess, so
 * silence is never mistaken for a clean file.
 */
export class DiagnosticsManager implements DiagnosticsBackend {
  readonly id = 'typescript'
  private readonly appDir: string
  private readonly workerPath: string | undefined
  private readonly timeouts: DiagnosticsTimeouts
  private readonly sessions = new Map<string, RootSession>()
  private readonly plans = new Map<string, { at: number; plan: Plan }>()
  private readonly trackedFiles = new Map<string, Set<string>>() // root key -> absolute paths
  private lastUsedRoot: string | undefined

  constructor(options: DiagnosticsManagerOptions = {}) {
    this.appDir = options.appDir ?? findAppDir(__dirname)
    this.workerPath = options.workerPath ?? resolveWorkerPath(__dirname)
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts }
  }

  /** The workspace most recently asked about; what a status question without a task falls back to. */
  get lastRoot(): string | undefined {
    return this.lastUsedRoot
  }

  handles(_root: string, abs: string): boolean {
    return sourceKind(abs) !== undefined
  }

  status(root: string): DiagnosticsStatus {
    this.lastUsedRoot = root
    const session = this.sessions.get(pathKey(root))
    // A worker that failed or refused to start explains why checks are not running.
    if (session && !session.worker && !session.status.available) return session.status
    const plan = this.plan(root)
    if (!plan.ok) return plan.status
    return session?.status ?? { available: true, engine: 'typescript', version: plan.version }
  }

  async check(request: BackendCheckRequest, signal?: AbortSignal): Promise<FileCheck | undefined> {
    if (signal?.aborted || request.after === null) return undefined
    if (!this.handles(request.root, request.abs)) return undefined
    const session = this.sessionFor(request.root)
    if (!session) return undefined
    this.touch(session)
    this.trackFile(request.root, request.abs)

    const { abs, before, after } = request
    const outcome = await this.enqueue(session, (id) => ({ id, kind: 'check', abs, before, after }), signal)
    return outcome.status === 'ok' ? { before: outcome.before, after: outcome.after } : undefined
  }

  async current(root: string, abs: string, signal?: AbortSignal): Promise<Diagnostic[] | undefined> {
    if (signal?.aborted || !this.handles(root, abs)) return undefined
    const session = this.sessionFor(root)
    if (!session) return undefined
    this.touch(session)
    this.trackFile(root, abs)

    const outcome = await this.enqueue(session, (id) => ({ id, kind: 'current', abs }), signal)
    return outcome.status === 'ok' ? outcome.after ?? [] : undefined
  }

  /**
   * Problems in `path` (workspace-relative or absolute), or in every file this app run has checked in the
   * workspace when no path is given. Empty when the checker cannot answer: status() says why.
   */
  async getDiagnostics(root: string, path?: string, signal?: AbortSignal): Promise<DiagnosticItem[]> {
    if (signal?.aborted) return []
    if (path) {
      const found = await this.current(root, isAbsolute(path) ? path : resolve(root, path), signal)
      return (found ?? []).slice(0, MAX_ITEMS).map(toItem)
    }

    const items: DiagnosticItem[] = []
    for (const abs of [...(this.trackedFiles.get(pathKey(root)) ?? [])].slice(-MAX_TRACKED_FILES)) {
      if (signal?.aborted || items.length >= MAX_ITEMS) break
      for (const d of (await this.current(root, abs, signal)) ?? []) items.push(toItem(d))
    }
    return items.slice(0, MAX_ITEMS)
  }

  /**
   * The hook the file tools call after a write: it reports only the problems the edit introduced. The whole call
   * is bounded, so a slow project delays the model's next step by seconds at most and then says nothing.
   */
  createDiagnoseHook(root: string): DiagnoseHook {
    return async (files: MutatedFile[], signal?: AbortSignal): Promise<DiagnosticsReport | undefined> => {
      if (signal?.aborted || files.length === 0) return undefined

      const budget = new AbortController()
      const timer = setTimeout(() => budget.abort(), this.timeouts.hookMs)
      const bounded = signal ? AbortSignal.any([signal, budget.signal]) : budget.signal
      try {
        const introduced: Diagnostic[][] = []
        for (const file of files) {
          if (bounded.aborted) return undefined
          if (file.after === null || !this.handles(root, file.abs)) continue
          const outcome = await this.check({
            root,
            abs: file.abs,
            before: file.existed ? strictUtf8(file.before) ?? null : null,
            after: file.after
          }, bounded)
          if (outcome) introduced.push(newDiagnostics(outcome.before ?? [], outcome.after ?? []))
        }
        return introduced.length > 0 ? buildReport(introduced) : undefined
      } finally {
        clearTimeout(timer)
      }
    }
  }

  /** Start the workspace's checker and build its program now, so the first edit does not wait for it. */
  warm(root: string): void {
    const session = this.sessionFor(root)
    if (!session) return
    this.touch(session)
    void this.enqueue(session, (id) => ({ id, kind: 'warm' }))
  }

  dispose(): void {
    for (const session of this.sessions.values()) this.closeSession(session)
    this.sessions.clear()
    this.plans.clear()
    this.trackedFiles.clear()
  }

  private trackFile(root: string, abs: string): void {
    const key = pathKey(root)
    let files = this.trackedFiles.get(key)
    if (!files) {
      files = new Set()
      this.trackedFiles.set(key, files)
    }
    files.delete(abs)
    files.add(abs)
    if (files.size > MAX_TRACKED_FILES * 4) files.delete(files.values().next().value as string)
  }

  /** Whether a checker can run for this folder at all, and which compiler it would use. */
  private plan(root: string): Plan {
    const key = pathKey(root)
    const cached = this.plans.get(key)
    if (cached && Date.now() - cached.at < PLAN_TTL_MS) return cached.plan
    const plan = this.makePlan(root)
    this.plans.set(key, { at: Date.now(), plan })
    return plan
  }

  private makePlan(root: string): Plan {
    const unavailable = (reason: string, version?: string): Plan => ({
      ok: false,
      status: { available: false, engine: 'typescript', ...(version ? { version } : {}), reason }
    })
    if (!this.workerPath) return unavailable(WORKER_MISSING_REASON)
    const typescript = probeTypeScript(root, this.appDir)
    if ('reason' in typescript) return unavailable(typescript.reason)
    if (!findProjectConfig(root)) return unavailable(NO_CONFIG_REASON, typescript.version)
    return { ok: true, version: typescript.version }
  }

  /** The workspace's live session, starting (or restarting) its worker when that is allowed. */
  private sessionFor(root: string): RootSession | undefined {
    this.lastUsedRoot = root
    const key = pathKey(root)
    const existing = this.sessions.get(key)
    if (existing) {
      if (!existing.worker && this.mayRestart(existing)) this.startWorker(existing)
      return existing.worker ? existing : undefined
    }

    const plan = this.plan(root)
    if (!plan.ok) return undefined
    const cancelBuffer = new SharedArrayBuffer(4)
    const session: RootSession = {
      root,
      cancelBuffer,
      cancel: new Int32Array(cancelBuffer),
      nextId: 0,
      queue: [],
      status: { available: true, engine: 'typescript', version: plan.version },
      version: plan.version,
      answered: 0,
      failures: 0,
      lastFailureAt: 0
    }
    this.sessions.set(key, session)
    this.startWorker(session)
    return session.worker ? session : undefined
  }

  private mayRestart(session: RootSession): boolean {
    if (session.failures >= MAX_WORKER_FAILURES) return false
    return session.failures <= 1 || Date.now() - session.lastFailureAt >= RESTART_AFTER_MS
  }

  private startWorker(session: RootSession): void {
    if (!this.workerPath) {
      this.fail(session, WORKER_MISSING_REASON, true)
      return
    }
    try {
      const worker = new Worker(this.workerPath, {
        workerData: { root: session.root, fallbackDir: this.appDir, cancel: session.cancelBuffer } satisfies WorkerInit
      })
      session.worker = worker
      session.status = { available: true, engine: 'typescript', version: session.version }
      // Each event is checked against the session's current worker: a replaced worker may still say its last words.
      worker.on('message', (message: WorkerResponse) => {
        if (session.worker === worker) this.onMessage(session, message)
      })
      worker.on('error', (error) => {
        if (session.worker === worker) this.fail(session, `The type checker stopped: ${error.message}. Cubex starts it again on a later edit.`)
      })
      worker.on('exit', (code) => {
        if (session.worker === worker) this.fail(session, `The type checker exited with code ${code}. Cubex starts it again on a later edit.`)
      })
    } catch (error) {
      this.fail(session, `The type checker could not start: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private onMessage(session: RootSession, message: WorkerResponse): void {
    if (message.kind === 'ready') {
      session.version = message.version
      session.status = { available: true, engine: 'typescript', version: message.version }
      return
    }
    // The workspace's own typescript is unusable and so is the app's: restarting cannot change that.
    if (message.kind === 'unavailable') {
      this.fail(session, message.reason, true)
      return
    }

    const inflight = session.inflight
    if (!inflight || inflight.id !== message.id) return
    clearTimeout(inflight.timer)
    if (inflight.stuck) clearTimeout(inflight.stuck)
    session.inflight = undefined
    if (message.outcome.status !== 'failed') {
      session.answered++
      session.failures = 0
    }
    this.settle(inflight.job, message.outcome)
    this.pump(session)
  }

  /** Give up on a worker: everything waiting on it resolves, and the session stays down until a restart is allowed. */
  private fail(session: RootSession, reason: string, permanent = false): void {
    const worker = session.worker
    session.worker = undefined
    if (worker) void worker.terminate().catch(() => undefined)
    session.status = { available: false, engine: 'typescript', version: session.version, reason }
    session.failures = permanent ? MAX_WORKER_FAILURES : session.failures + 1
    session.lastFailureAt = Date.now()

    const inflight = session.inflight
    session.inflight = undefined
    if (inflight) {
      clearTimeout(inflight.timer)
      if (inflight.stuck) clearTimeout(inflight.stuck)
      this.settle(inflight.job, { status: 'failed', reason })
    }
    for (const job of session.queue.splice(0)) this.settle(job, { status: 'failed', reason })
  }

  private enqueue(session: RootSession, build: Job['build'], signal?: AbortSignal): Promise<CheckOutcome> {
    if (signal?.aborted) return Promise.resolve({ status: 'cancelled' })
    return new Promise<CheckOutcome>((resolveOutcome) => {
      const job: Job = { build, resolve: resolveOutcome, settled: false }
      if (signal) {
        job.signal = signal
        job.onAbort = () => this.abort(session, job)
        signal.addEventListener('abort', job.onAbort, { once: true })
      }
      session.queue.push(job)
      this.pump(session)
    })
  }

  private settle(job: Job, outcome: CheckOutcome): void {
    if (job.settled) return
    job.settled = true
    if (job.signal && job.onAbort) job.signal.removeEventListener('abort', job.onAbort)
    job.resolve(outcome)
  }

  /** The caller stopped waiting. A queued job is dropped; a running one is told to stop and its late answer is ignored. */
  private abort(session: RootSession, job: Job): void {
    const queued = session.queue.indexOf(job)
    if (queued >= 0) session.queue.splice(queued, 1)
    else if (session.inflight?.job === job) Atomics.store(session.cancel, 0, session.inflight.id)
    this.settle(job, { status: 'cancelled' })
  }

  /** Send the next job when the worker is idle. The job's clock starts here, not when it was asked for. */
  private pump(session: RootSession): void {
    if (session.inflight || !session.worker) return
    const job = session.queue.shift()
    if (!job) return
    const id = ++session.nextId
    const limit = session.answered === 0 ? this.timeouts.coldMs : this.timeouts.requestMs
    const timer = setTimeout(() => this.timeOut(session, id), limit)
    timer.unref()
    session.inflight = { id, job, timer }
    session.worker.postMessage(job.build(id))
  }

  /**
   * A request ran out of time. The caller is released now and the compiler is told to stop at its next
   * checkpoint, which is usually within milliseconds. A worker that still has not answered after `stuckMs`
   * is replaced, so one runaway check cannot block the workspace for good.
   */
  private timeOut(session: RootSession, id: number): void {
    const inflight = session.inflight
    if (!inflight || inflight.id !== id) return
    Atomics.store(session.cancel, 0, id)
    this.settle(inflight.job, { status: 'cancelled' })
    inflight.stuck = setTimeout(() => {
      if (session.inflight?.id === id) this.fail(session, 'The type checker stopped answering and was shut down. Cubex starts it again on a later edit.')
    }, this.timeouts.stuckMs)
    inflight.stuck.unref()
  }

  private touch(session: RootSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.idleTimer = setTimeout(() => {
      this.closeSession(session)
      this.sessions.delete(pathKey(session.root))
    }, this.timeouts.idleMs)
    session.idleTimer.unref()
  }

  private closeSession(session: RootSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.idleTimer = undefined
    const worker = session.worker
    session.worker = undefined
    if (worker) void worker.terminate().catch(() => undefined)
    const inflight = session.inflight
    session.inflight = undefined
    if (inflight) {
      clearTimeout(inflight.timer)
      if (inflight.stuck) clearTimeout(inflight.stuck)
      this.settle(inflight.job, { status: 'cancelled' })
    }
    for (const job of session.queue.splice(0)) this.settle(job, { status: 'cancelled' })
  }
}
