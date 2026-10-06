import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { PLAN_MAX_FEEDBACK_LENGTH, type PermissionMode, type PlanAsk, type PlanDecision, type PlanStatus } from '@shared/ipc'

export const MAX_PLAN_BYTES = 128 * 1024
const MAX_METADATA_BYTES = 64 * 1024
const PLAN_ID = /^([a-f0-9]{32})_[a-f0-9]{32}$/

export interface PlanResolution {
  decision: PlanDecision
  feedback?: string
  cancelled?: boolean
}

interface PlanMetadata {
  id: string
  conversationId: string
  title: string
  /** Generated document basename. Older receipts use <id>.md instead. */
  fileName?: string
  createdAt: number
  status: PlanStatus
  decision?: PlanDecision
  feedback?: string
  resolvedAt?: number
}

export function validatePlanResolution(decision: unknown, feedback?: unknown): PlanResolution {
  if (decision !== 'reject' && decision !== 'default' && decision !== 'acceptEdits' && decision !== 'bypass') {
    throw new Error('Invalid plan decision.')
  }
  if (feedback !== undefined && (typeof feedback !== 'string' || feedback.length > PLAN_MAX_FEEDBACK_LENGTH)) {
    throw new Error(`Plan feedback must be text of at most ${PLAN_MAX_FEEDBACK_LENGTH} characters.`)
  }
  return { decision, ...(feedback !== undefined ? { feedback: feedback as string } : {}) }
}

export function validatePlanInput(input: unknown): { plan: string; title?: string } {
  const value = input as { plan?: unknown; title?: unknown } | null
  if (!value || typeof value.plan !== 'string' || !value.plan.trim()) {
    throw new Error('exit_plan_mode requires a non-empty Markdown plan in "plan".')
  }
  if (Buffer.byteLength(value.plan, 'utf8') > MAX_PLAN_BYTES) {
    throw new Error(`Plan is too large; use at most ${MAX_PLAN_BYTES} UTF-8 bytes.`)
  }
  if (value.title !== undefined && (typeof value.title !== 'string' || value.title.length > 160)) {
    throw new Error('Plan title must be text of at most 160 characters.')
  }
  return { plan: value.plan, ...(typeof value.title === 'string' && value.title.trim() ? { title: value.title.trim() } : {}) }
}

function conversationKey(conversationId: unknown): string {
  if (typeof conversationId !== 'string' || !conversationId.trim() || conversationId.length > 256) {
    throw new Error('A valid conversation id is required for a plan.')
  }
  // Imported conversation IDs need not be filesystem-safe. No ID becomes a path.
  return createHash('sha256').update(conversationId).digest('hex').slice(0, 32)
}

function titleFor(plan: string): string {
  return (plan.match(/^#{1,6}\s+(.+)$/m)?.[1]?.replace(/\s+#+\s*$/, '').trim() || 'Implementation plan').slice(0, 160)
}

function markdownFileName(title: string, id: string): string {
  const slug = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'implementation-plan'
  return `${slug}-${id.slice(-8)}.md`
}

/** Immutable .md revisions, with an atomically replaced review receipt beside each file. */
export class PlanStore {
  private readonly root: string
  private readonly currentReviews = new Set<string>()
  private lastCreatedAt = 0

  constructor(root: string) {
    mkdirSync(resolve(root), { recursive: true })
    this.root = realpathSync.native(resolve(root))
  }

  create(conversationId: string, input: unknown): PlanAsk {
    const key = conversationKey(conversationId)
    const { plan, title } = validatePlanInput(input)
    const dir = this.directory(key, true)
    const id = `${key}_${randomUUID().replace(/-/g, '')}`
    const createdAt = Math.max(Date.now(), this.lastCreatedAt + 1)
    this.lastCreatedAt = createdAt
    const resolvedTitle = title ?? titleFor(plan)
    const fileName = markdownFileName(resolvedTitle, id)
    const metadata: PlanMetadata = { id, conversationId, title: resolvedTitle, fileName, createdAt, status: 'pending' }
    const path = join(dir, fileName)
    // Never replace an earlier document, including a rare short-suffix collision.
    if (existsSync(path) || existsSync(join(dir, `${id}.json`))) throw new Error('Plan filename already exists. Submit the plan again to allocate a new revision.')
    this.atomicWrite(path, plan)
    try {
      this.atomicWrite(join(dir, `${id}.json`), JSON.stringify(metadata))
    } catch (error) {
      // A plan is visible only once its receipt is durable.
      unlinkSync(path)
      throw error
    }
    this.currentReviews.add(id)
    return { ...metadata, plan, path }
  }

  list(conversationId: string): PlanAsk[] {
    const key = conversationKey(conversationId)
    const dir = this.directory(key)
    if (!existsSync(dir)) return []
    const plans: PlanAsk[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const id = entry.name.slice(0, -5)
      if (!PLAN_ID.test(id)) continue
      try {
        const plan = this.get(id)
        if (plan?.conversationId === conversationId) plans.push(plan)
      } catch { /* One damaged receipt must not hide the other revisions. */ }
    }
    return plans.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  }

  get(id: string): PlanAsk | null {
    const match = typeof id === 'string' ? PLAN_ID.exec(id) : null
    if (!match) throw new Error('Invalid plan id.')
    const dir = this.directory(match[1]!)
    const metadataPath = join(dir, `${id}.json`)
    if (!existsSync(metadataPath)) return null
    const raw = JSON.parse(this.readFile(metadataPath, MAX_METADATA_BYTES)) as PlanMetadata
    if (raw.id !== id || conversationKey(raw.conversationId) !== match[1] ||
        typeof raw.title !== 'string' || raw.title.length > 160 ||
        !Number.isFinite(raw.createdAt) || (raw.resolvedAt !== undefined && !Number.isFinite(raw.resolvedAt)) ||
        !['pending', 'approved', 'rejected', 'cancelled'].includes(raw.status)) {
      throw new Error('Invalid plan metadata.')
    }
    // New readable names are derived and verified, never accepted as arbitrary
    // paths. Legacy receipts remain readable without renaming their documents.
    if (raw.fileName !== undefined && raw.fileName !== markdownFileName(raw.title, id)) {
      throw new Error('Invalid plan document filename.')
    }
    const path = join(dir, raw.fileName ?? `${id}.md`)
    if (!existsSync(path)) return null
    if (raw.feedback !== undefined && (typeof raw.feedback !== 'string' || raw.feedback.length > PLAN_MAX_FEEDBACK_LENGTH)) {
      throw new Error('Invalid plan feedback.')
    }
    if (raw.decision !== undefined) validatePlanResolution(raw.decision)
    const { plan } = validatePlanInput({ plan: this.readFile(path, MAX_PLAN_BYTES) })
    // An approval cannot survive a process restart: its waiting model turn is gone.
    if (raw.status === 'pending' && !this.currentReviews.has(id)) {
      raw.status = 'cancelled'
      raw.resolvedAt = Date.now()
      this.atomicWrite(metadataPath, JSON.stringify(raw))
    }
    // Pick fields explicitly so forged metadata can never supply a reveal path.
    return {
      id, plan, path, title: raw.title, conversationId: raw.conversationId,
      createdAt: raw.createdAt, status: raw.status,
      ...(raw.decision !== undefined ? { decision: raw.decision } : {}),
      ...(raw.feedback !== undefined ? { feedback: raw.feedback } : {}),
      ...(raw.resolvedAt !== undefined ? { resolvedAt: raw.resolvedAt } : {})
    }
  }

  settle(id: string, resolution: PlanResolution): PlanAsk {
    const validated = validatePlanResolution(resolution.decision, resolution.feedback)
    const plan = this.get(id)
    if (!plan || plan.status !== 'pending') throw new Error('This plan is no longer awaiting review.')
    const status: PlanStatus = resolution.cancelled ? 'cancelled' : validated.decision === 'reject' ? 'rejected' : 'approved'
    const metadata: PlanMetadata = {
      id, conversationId: plan.conversationId!, title: plan.title!, createdAt: plan.createdAt!,
      ...(basename(plan.path!) !== `${id}.md` ? { fileName: basename(plan.path!) } : {}),
      status, resolvedAt: Date.now(), ...(!resolution.cancelled ? validated : {})
    }
    this.atomicWrite(join(this.directory(id.slice(0, 32)), `${id}.json`), JSON.stringify(metadata))
    this.currentReviews.delete(id)
    return { ...plan, ...metadata }
  }

  cancel(id: string): void {
    try { this.settle(id, { decision: 'reject', cancelled: true }) }
    finally { this.currentReviews.delete(id) }
  }

  /**
   * Delete the revisions a conversation made at or after `since` and hand them back, for a restore to an
   * earlier message. `restore` puts exactly these back if the restore is undone.
   */
  removeSince(conversationId: string, since: number): PlanAsk[] {
    const removed = this.list(conversationId).filter((plan) => (plan.createdAt ?? 0) >= since)
    const dir = this.directory(conversationKey(conversationId))
    for (const plan of removed) {
      this.currentReviews.delete(plan.id)
      rmSync(join(dir, basename(plan.path!)), { force: true })
      rmSync(join(dir, `${plan.id}.json`), { force: true })
    }
    return removed
  }

  /** Write back revisions that `removeSince` returned, with their review outcome. */
  restore(plans: PlanAsk[]): void {
    for (const plan of plans) {
      const key = conversationKey(plan.conversationId)
      if (PLAN_ID.exec(plan.id)?.[1] !== key || !plan.title || plan.createdAt === undefined || !plan.status) {
        throw new Error('Invalid plan revision.')
      }
      const dir = this.directory(key, true)
      const fileName = markdownFileName(plan.title, plan.id)
      const metadata: PlanMetadata = {
        id: plan.id, conversationId: plan.conversationId!, title: plan.title, fileName, createdAt: plan.createdAt, status: plan.status,
        ...(plan.decision !== undefined ? { decision: plan.decision } : {}),
        ...(plan.feedback !== undefined ? { feedback: plan.feedback } : {}),
        ...(plan.resolvedAt !== undefined ? { resolvedAt: plan.resolvedAt } : {})
      }
      this.atomicWrite(join(dir, fileName), plan.plan)
      this.atomicWrite(join(dir, `${plan.id}.json`), JSON.stringify(metadata))
    }
  }

  /** Drop every plan revision for a deleted conversation. Pending reviews are cancelled first. */
  deleteConversation(conversationId: string): void {
    const key = conversationKey(conversationId)
    for (const id of [...this.currentReviews]) {
      if (!id.startsWith(`${key}_`)) continue
      try { this.cancel(id) } catch { /* receipt may already be settled */ }
    }
    const dir = this.directory(key)
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }

  private directory(key: string, create = false): string {
    const dir = join(this.root, key)
    if (existsSync(dir)) {
      const stat = lstatSync(dir)
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(dir) !== dir) {
        throw new Error('Plan directory must remain inside the artifact store.')
      }
    } else if (create) mkdirSync(dir)
    return dir
  }

  private readFile(path: string, maxBytes: number): string {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('Invalid plan artifact.')
    return readFileSync(path, 'utf8')
  }

  private atomicWrite(path: string, content: string): void {
    if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) {
      throw new Error('Invalid plan artifact destination.')
    }
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      const descriptor = openSync(temp, 'wx', 0o600)
      try {
        writeFileSync(descriptor, content, 'utf8')
        fsyncSync(descriptor)
      } finally { closeSync(descriptor) }
      renameSync(temp, path)
    } finally { if (existsSync(temp)) unlinkSync(temp) }
  }
}

/** Owns each wait, including cancellation. IPC acknowledgement happens after durable settlement. */
export class PlanReviews {
  private readonly pending = new Map<string, (resolution: PlanResolution) => void>()

  constructor(private readonly store: PlanStore, private readonly onPersistenceError: (error: unknown) => void = () => {}) {}

  request(conversationId: string, input: unknown, signal: AbortSignal, emit: (ask: PlanAsk) => void): Promise<PlanResolution> {
    if (signal.aborted) return Promise.resolve({ decision: 'reject', cancelled: true })
    const ask = this.store.create(conversationId, input)
    return new Promise((resolvePromise) => {
      const finish = (resolution: PlanResolution): void => {
        signal.removeEventListener('abort', onAbort)
        this.pending.delete(ask.id)
        resolvePromise(resolution)
      }
      const onAbort = (): void => {
        const resolution: PlanResolution = { decision: 'reject', cancelled: true }
        try { this.store.cancel(ask.id) } catch (error) { this.onPersistenceError(error) }
        finish(resolution)
      }
      this.pending.set(ask.id, finish)
      signal.addEventListener('abort', onAbort, { once: true })
      try { emit(ask) } catch (error) {
        onAbort()
        this.onPersistenceError(error)
      }
    })
  }

  resolve(id: string, decision: unknown, feedback?: unknown): void {
    const resolution = validatePlanResolution(decision, feedback)
    const finish = this.pending.get(id)
    if (!finish) throw new Error('This plan is no longer awaiting review. Submit a new plan to continue.')
    this.store.settle(id, resolution)
    finish(resolution)
  }
}

export function planResolutionResult(resolution: PlanResolution): { mode: PermissionMode; text: string; isError?: boolean } {
  if (resolution.cancelled) return { mode: 'plan', text: 'Plan review cancelled. No implementation was approved.', isError: true }
  if (resolution.decision === 'reject') {
    return {
      mode: 'plan', isError: true,
      text: 'The user rejected this plan. PLAN MODE remains active. Do not implement or modify anything. ' +
        'Revise the plan using the feedback below and submit the full revised Markdown with exit_plan_mode for a new review.' +
        (resolution.feedback !== undefined ? `\n\nUser feedback (verbatim):\n${resolution.feedback}` : '')
    }
  }
  return {
    mode: resolution.decision,
    text: `Plan approved. Permission mode is now "${resolution.decision}". Implement the approved plan and verify the result, observing the current tool permissions. Do not call exit_plan_mode again or re-ask for plan approval.` +
      (resolution.feedback !== undefined ? `\n\nUser feedback (verbatim):\n${resolution.feedback}` : '')
  }
}
