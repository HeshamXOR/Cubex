import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { PLAN_MAX_FEEDBACK_LENGTH, type PlanAsk } from '@shared/ipc'
import { MAX_PLAN_BYTES, PlanReviews, PlanStore, planResolutionResult, validatePlanInput, validatePlanResolution } from './plans'

let dir: string
let store: PlanStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cubex-plans-'))
  store = new PlanStore(join(dir, 'plans'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe('Markdown plan artifacts', () => {
  it('saves exact Markdown in generated paths and keeps all revisions after restart', () => {
    const markdown = '# Correct the parser\n\n1. Preserve comments.\n2. Run parser tests.\n'
    const first = store.create('../outside/CON', { plan: markdown, title: 'Parser changes', path: 'do-not-use.md' })
    expect(readFileSync(first.path!, 'utf8')).toBe(markdown)
    expect(relative(realpathSync.native(join(dir, 'plans')), first.path!)).not.toMatch(/^\.\./)
    expect(first.path).not.toContain('outside')
    expect(basename(first.path!)).toMatch(/^parser-changes-[a-f0-9]{8}\.md$/)
    store.settle(first.id, { decision: 'reject', feedback: 'Cover nested comments too.' })
    const second = store.create('../outside/CON', { plan: '# Revised parser plan\n\n1. Cover nested comments.' })
    store.settle(second.id, { decision: 'acceptEdits' })

    const reopened = new PlanStore(join(dir, 'plans'))
    const plans = reopened.list('../outside/CON')
    expect(plans.map((plan) => plan.id)).toEqual([second.id, first.id])
    expect(plans.map((plan) => plan.status)).toEqual(['approved', 'rejected'])
    expect(plans[1]?.feedback).toBe('Cover nested comments too.')
    expect(readFileSync(first.path!, 'utf8')).toBe(markdown)
    expect(readdirSync(dirname(first.path!)).sort()).toEqual([
      `${first.id}.json`, basename(first.path!), `${second.id}.json`, basename(second.path!)
    ].sort())
    expect(reopened.list('unrelated')).toEqual([])
  })

  it('marks interrupted pending reviews cancelled on restart without losing the document', () => {
    const plan = store.create('task', { plan: '# Review me' })
    expect(store.get(plan.id)?.status).toBe('pending')
    expect(new PlanStore(join(dir, 'plans')).get(plan.id)).toMatchObject({ plan: '# Review me', status: 'cancelled' })
    expect(() => store.settle(plan.id, { decision: 'bypass' })).toThrow('no longer awaiting review')
  })

  it('rejects empty, wrong-type and oversized input before creating artifacts', () => {
    for (const input of [null, {}, { plan: 42 }, { plan: ' \n' }, { plan: 'x'.repeat(MAX_PLAN_BYTES + 1) }, { plan: 'é'.repeat(MAX_PLAN_BYTES) }]) {
      expect(() => store.create('task', input)).toThrow()
    }
    expect(() => validatePlanInput({ plan: '# Valid', title: 'x'.repeat(161) })).toThrow('title')
    expect(store.list('task')).toEqual([])
    expect(() => store.get('../../secret.md')).toThrow('Invalid plan id')
    expect(() => store.list('')).toThrow('conversation id')
  })

  it('ignores forged receipt paths and rejects a symlinked conversation directory', () => {
    const plan = store.create('task', { plan: '# Safe plan' })
    const receipt = join(dirname(plan.path!), `${plan.id}.json`)
    const metadata = JSON.parse(readFileSync(receipt, 'utf8'))
    writeFileSync(receipt, JSON.stringify({ ...metadata, path: join(dir, 'secret.txt') }))
    expect(store.get(plan.id)?.path).toBe(plan.path)
    const artifactDirectory = dirname(plan.path!)
    rmSync(artifactDirectory, { recursive: true })
    symlinkSync(dir, artifactDirectory, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => store.get(plan.id)).toThrow('artifact store')
  })

  it('keeps older id-named documents readable and resolvable alongside new readable filenames', () => {
    const legacy = store.create('task', { plan: '# Original plan' })
    const artifactDir = dirname(legacy.path!)
    const receipt = join(artifactDir, `${legacy.id}.json`)
    const raw = JSON.parse(readFileSync(receipt, 'utf8'))
    delete raw.fileName
    writeFileSync(receipt, JSON.stringify(raw))
    const legacyPath = join(artifactDir, `${legacy.id}.md`)
    renameSync(legacy.path!, legacyPath)
    expect(store.get(legacy.id)).toMatchObject({ path: legacyPath, plan: '# Original plan', status: 'pending' })
    store.settle(legacy.id, { decision: 'reject', feedback: 'Add verification.' })
    const revised = store.create('task', { plan: '# Original plan\n\n1. Verify the parser.' })
    store.settle(revised.id, { decision: 'default' })
    const reopened = new PlanStore(join(dir, 'plans'))
    expect(reopened.list('task').map((plan) => plan.path)).toEqual([revised.path, legacyPath])
    expect(reopened.get(legacy.id)?.feedback).toBe('Add verification.')
    expect(reopened.get(revised.id)?.status).toBe('approved')
    expect(readFileSync(legacyPath, 'utf8')).toBe('# Original plan')
  })

  it('sanitizes titles, preserves separate revisions and rejects forged document basenames', () => {
    const title = '../CON: Fix C:\\parser / café?'
    const first = store.create('task', { plan: '# First', title })
    const second = store.create('task', { plan: '# Second', title })
    expect(basename(first.path!)).toMatch(/^con-fix-c-parser-cafe-[a-f0-9]{8}\.md$/)
    expect(first.path).not.toBe(second.path)
    expect(first.id).not.toBe(second.id)
    expect(readFileSync(first.path!, 'utf8')).toBe('# First')
    const receipt = join(dirname(first.path!), `${first.id}.json`)
    const metadata = JSON.parse(readFileSync(receipt, 'utf8'))
    writeFileSync(receipt, JSON.stringify({ ...metadata, fileName: '../secret.md' }))
    expect(() => store.get(first.id)).toThrow('Invalid plan document filename')
    writeFileSync(receipt, JSON.stringify({ ...metadata, fileName: basename(second.path!) }))
    expect(() => store.get(first.id)).toThrow('Invalid plan document filename')
  })
})

describe('plan review lifecycle', () => {
  it('returns rejection guidance verbatim and requires a fresh review to approve a revision', async () => {
    const reviews = new PlanReviews(store)
    const controller = new AbortController()
    let ask!: PlanAsk
    const pending = reviews.request('task', { plan: '# Initial plan' }, controller.signal, (value) => { ask = value })
    const feedback = '  Keep the parser public.\nUse `parse(text)` — do not add a wrapper.  '
    reviews.resolve(ask.id, 'reject', feedback)
    const resolution = await pending
    expect(planResolutionResult(resolution)).toMatchObject({ mode: 'plan', isError: true })
    expect(planResolutionResult(resolution).text).toContain(`User feedback (verbatim):\n${feedback}`)
    expect(store.get(ask.id)).toMatchObject({ status: 'rejected', feedback })
    expect(() => reviews.resolve(ask.id, 'bypass')).toThrow('no longer awaiting review')

    const revised = reviews.request('task', { plan: '# Revised plan' }, controller.signal, (value) => { ask = value })
    reviews.resolve(ask.id, 'acceptEdits')
    expect(planResolutionResult(await revised)).toMatchObject({ mode: 'acceptEdits' })
    expect(store.list('task').map((plan) => plan.status)).toEqual(['approved', 'rejected'])
  })

  it('validates IPC decisions and feedback before settling the review', async () => {
    const reviews = new PlanReviews(store)
    let ask!: PlanAsk
    const pending = reviews.request('task', { plan: '# Plan' }, new AbortController().signal, (value) => { ask = value })
    expect(() => reviews.resolve(ask.id, 'allow')).toThrow('Invalid plan decision')
    expect(() => reviews.resolve(ask.id, 'reject', 'x'.repeat(PLAN_MAX_FEEDBACK_LENGTH + 1))).toThrow('feedback')
    expect(() => validatePlanResolution('reject', { text: 'feedback' })).toThrow('feedback')
    expect(store.get(ask.id)?.status).toBe('pending')
    reviews.resolve(ask.id, 'default')
    expect(await pending).toEqual({ decision: 'default' })
  })

  it('cancels deterministically, removes its abort listener and rejects stale responses', async () => {
    const reviews = new PlanReviews(store)
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    let ask!: PlanAsk
    const pending = reviews.request('task', { plan: '# Plan' }, controller.signal, (value) => { ask = value })
    controller.abort()
    expect(await pending).toEqual({ decision: 'reject', cancelled: true })
    expect(store.get(ask.id)?.status).toBe('cancelled')
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(() => reviews.resolve(ask.id, 'default')).toThrow('no longer awaiting review')
    const emit = vi.fn()
    await expect(reviews.request('task', { plan: '# Never submitted' }, controller.signal, emit)).resolves.toMatchObject({ cancelled: true })
    expect(emit).not.toHaveBeenCalled()
    expect(store.list('task')).toHaveLength(1)
  })

  it('keeps a review pending if its durable receipt cannot be saved', async () => {
    const reviews = new PlanReviews(store)
    let ask!: PlanAsk
    const pending = reviews.request('task', { plan: '# Plan' }, new AbortController().signal, (value) => { ask = value })
    vi.spyOn(store, 'settle').mockImplementationOnce(() => { throw new Error('disk full') })
    expect(() => reviews.resolve(ask.id, 'acceptEdits')).toThrow('disk full')
    expect(store.get(ask.id)?.status).toBe('pending')
    reviews.resolve(ask.id, 'reject', 'Try a smaller change')
    expect(await pending).toMatchObject({ decision: 'reject', feedback: 'Try a smaller change' })
  })

  it('still cancels a waiting turn when saving the cancellation receipt fails', async () => {
    const report = vi.fn()
    const reviews = new PlanReviews(store, report)
    const controller = new AbortController()
    let ask!: PlanAsk
    const pending = reviews.request('task', { plan: '# Plan' }, controller.signal, (value) => { ask = value })
    vi.spyOn(store, 'settle').mockImplementationOnce(() => { throw new Error('disk full') })
    controller.abort()
    expect(await pending).toMatchObject({ cancelled: true })
    expect(report).toHaveBeenCalledOnce()
    expect(() => reviews.resolve(ask.id, 'bypass')).toThrow('no longer awaiting review')
    expect(store.get(ask.id)?.status).toBe('cancelled')
  })
})

describe('plans of turns a restore removes', () => {
  /** Three plans created at known times: before the restore point, and at or after it. */
  function plansAt(times: number[]): PlanAsk[] {
    vi.useFakeTimers()
    try {
      return times.map((time, index) => {
        vi.setSystemTime(time)
        const plan = store.create('task', { plan: `# Plan ${index + 1}\n\nBody ${index + 1}`, title: `Plan ${index + 1}` })
        return index === 1 ? store.settle(plan.id, { decision: 'reject', feedback: 'Smaller steps' }) : plan
      })
    } finally { vi.useRealTimers() }
  }

  it('removes the revisions made at or after a time, from disk too, and returns them', () => {
    const [early, middle, late] = plansAt([1_000, 2_000, 3_000])
    const removed = store.removeSince('task', 2_000)
    expect(removed.map((plan) => plan.id)).toEqual([late!.id, middle!.id])
    expect(store.list('task').map((plan) => plan.id)).toEqual([early!.id])
    expect(readdirSync(dirname(early!.path!)).sort()).toEqual([`${early!.id}.json`, basename(early!.path!)].sort())
    expect(store.removeSince('task', 5_000)).toEqual([])
    expect(store.removeSince('another-task', 0)).toEqual([])
  })

  it('puts removed revisions back exactly as they were, outcome included', () => {
    const [, middle] = plansAt([1_000, 2_000, 3_000])
    const removed = store.removeSince('task', 2_000)
    expect(store.list('task')).toHaveLength(1)
    store.restore(removed)
    const restored = store.list('task')
    expect(restored).toHaveLength(3)
    const back = restored.find((plan) => plan.id === middle!.id)!
    expect(back).toMatchObject({ title: 'Plan 2', status: 'rejected', decision: 'reject', feedback: 'Smaller steps', createdAt: 2_000 })
    expect(readFileSync(back.path!, 'utf8')).toBe('# Plan 2\n\nBody 2')
    expect(new PlanStore(join(dir, 'plans')).list('task')).toHaveLength(3)
  })

  it('refuses to restore a revision that does not belong to its conversation', () => {
    const [plan] = plansAt([1_000])
    expect(() => store.restore([{ ...plan!, conversationId: 'someone-else' }])).toThrow('Invalid plan revision')
    expect(() => store.restore([{ ...plan!, id: '../../escape' }])).toThrow('Invalid plan revision')
  })
})
