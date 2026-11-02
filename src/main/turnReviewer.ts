import type { AIRequest, AIResponse, Usage } from '@core/types'
import type { AppSettings } from '@shared/settings'

/**
 * The optional reviewer pass: before a turn that changed files ends, a second model reads the task and the diff and
 * either approves or returns concrete fixes. The caller sends the fixes back to the main model as one more message,
 * once per turn. A reviewer that fails or rambles must never block the turn, so every failure here reads as approve.
 */

export interface TurnReviewInput {
  /** What the person asked for. */
  task: string
  /** The unified diff of everything the turn changed. */
  diff: string
  /** What the main model said at the end of the turn. */
  finalText: string
  /** The result of any checks the turn ran (tests, type check), as text. */
  checks?: string
  workspace?: string
}

export interface TurnReviewResult {
  verdict: 'approve' | 'revise'
  /** A short numbered list of fixes. Empty on approve. */
  feedback: string
  usage?: Usage
}

export interface TurnReviewOptions {
  signal?: AbortSignal
  /** Most of the diff that is shown to the reviewer. Default 40,000 characters. */
  maxDiffChars?: number
  /** Goes on the request as is. A `send` that picks the reviewer's model itself can leave it out. */
  model?: string
}

export const DEFAULT_MAX_DIFF_CHARS = 40_000
const MAX_SIDE_TEXT_CHARS = 4_000
const APPROVED: TurnReviewResult = { verdict: 'approve', feedback: '' }

const SYSTEM_PROMPT = `You review the changes a coding agent made for one task. You see the task, the agent's closing message, any check output and the diff.

Report only:
- correctness bugs in the changed code
- requirements of the task that the changes miss
- edge cases the changes break
- edits that go outside the task's scope

Ignore style, naming, formatting and taste. Do not ask for tests or comments unless the task did. Do not repeat what the agent already got right. If you are unsure that something is a real problem, leave it out.

Reply with strict JSON and nothing else:
{"verdict":"approve"|"revise","feedback":"..."}
Use "approve" with an empty feedback when there is nothing concrete to fix. Use "revise" only with feedback written as a short numbered list of concrete fixes, each naming the file and what to change.`

/** Which model reviews, or undefined when the reviewer is off or no model is chosen. */
export function reviewerTarget(settings: { ai: Pick<AppSettings['ai'], 'reviewer'> }): { providerId: string; model: string } | undefined {
  const reviewer = settings.ai.reviewer
  if (!reviewer?.enabled) return undefined
  const providerId = reviewer.providerId?.trim()
  const model = reviewer.model?.trim()
  return providerId && model ? { providerId, model } : undefined
}

// --- Diff ---------------------------------------------------------------------------------

function fileOfUnit(unit: string): string {
  const head = /^diff --git a\/(.+?) b\/\S+/m.exec(unit)
  if (head?.[1]) return head[1]
  const plus = /^\+\+\+ (?:b\/)?(\S+)/m.exec(unit)
  return plus?.[1] ?? 'unknown file'
}

/** One file's header, then as many of its hunks as fit, whole. Undefined when not even the header and one hunk fit. */
function fitUnit(unit: string, budget: number): { text: string; omitted: number } | undefined {
  if (unit.length <= budget) return { text: unit, omitted: 0 }
  const start = unit.search(/^@@ /m)
  if (start < 0) return undefined
  const header = unit.slice(0, start)
  const hunks = unit.slice(start).split(/^(?=@@ )/m)
  let text = header
  let kept = 0
  for (const hunk of hunks) {
    if (text.length + hunk.length > budget) break
    text += hunk
    kept++
  }
  return kept === 0 ? undefined : { text, omitted: hunks.length - kept }
}

/** Cut a diff to about `maxChars` without cutting a hunk in half, and say what went. Whole files first, then whole hunks. */
export function truncateDiff(diff: string, maxChars = DEFAULT_MAX_DIFF_CHARS): string {
  if (diff.length <= maxChars) return diff
  const units = diff.split(/^(?=diff --git )/m).filter((unit) => unit.length > 0)
  const notes: string[] = []
  let out = ''
  for (const unit of units) {
    // Leave room for the note below.
    const fit = fitUnit(unit, Math.max(0, maxChars - out.length - 300))
    if (!fit) {
      notes.push(`${fileOfUnit(unit)} (whole file)`)
      continue
    }
    out += fit.text.endsWith('\n') ? fit.text : `${fit.text}\n`
    if (fit.omitted > 0) notes.push(`${fileOfUnit(unit)} (${fit.omitted} more ${fit.omitted === 1 ? 'hunk' : 'hunks'})`)
  }
  const shown = notes.length === 0 ? 'nothing' : notes.join(', ')
  return `${out}[Diff cut to fit. Not shown: ${shown}. What is shown above is complete.]\n`
}

// --- Reply --------------------------------------------------------------------------------

/** Every top-level {...} in the text, string-aware, so prose with braces around the JSON does not hide it. */
function objectsIn(text: string): string[] {
  const found: string[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue
    let depth = 0
    let inString = false
    for (let j = i; j < text.length; j++) {
      const ch = text[j]
      if (inString) {
        if (ch === '\\') j++
        else if (ch === '"') inString = false
      } else if (ch === '"') inString = true
      else if (ch === '{') depth++
      else if (ch === '}' && --depth === 0) {
        found.push(text.slice(i, j + 1))
        i = j
        break
      }
    }
  }
  return found
}

function feedbackText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    return items.map((item, index) => (/^\d+[.)]\s/.test(item) ? item : `${index + 1}. ${item}`)).join('\n')
  }
  return ''
}

/** Read the reviewer's reply. Anything that is not a clear request for changes is an approval. */
export function parseReview(text: string): TurnReviewResult {
  const unfenced = text.replace(/```(?:json)?/gi, '')
  for (const candidate of objectsIn(unfenced)) {
    let value: unknown
    try { value = JSON.parse(candidate) } catch { continue }
    if (!value || typeof value !== 'object') continue
    const { verdict, feedback } = value as { verdict?: unknown; feedback?: unknown }
    if (typeof verdict !== 'string') continue
    const word = verdict.trim().toLowerCase()
    if (word === 'revise' || word === 'reject' || word === 'changes_requested') {
      const fixes = feedbackText(feedback)
      // Revise with nothing to act on would only cost the main model a pointless turn.
      return fixes ? { verdict: 'revise', feedback: fixes } : APPROVED
    }
    if (word === 'approve' || word === 'approved') return APPROVED
  }
  return APPROVED
}

// --- Review -------------------------------------------------------------------------------

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}\n[cut]`)

function promptOf(input: TurnReviewInput, maxDiffChars: number): string {
  const parts = [`Task:\n${clip(input.task.trim(), MAX_SIDE_TEXT_CHARS)}`]
  if (input.workspace) parts.push(`Project folder: ${input.workspace}`)
  if (input.finalText.trim()) parts.push(`The agent's closing message:\n${clip(input.finalText.trim(), MAX_SIDE_TEXT_CHARS)}`)
  if (input.checks?.trim()) parts.push(`Checks the agent ran:\n${clip(input.checks.trim(), MAX_SIDE_TEXT_CHARS)}`)
  parts.push(`Diff:\n${truncateDiff(input.diff, maxDiffChars)}`)
  return parts.join('\n\n')
}

/** Ask the reviewer model. `send` sends one request with no tools and returns the whole reply. Never throws. */
export async function reviewTurn(
  input: TurnReviewInput,
  send: (request: AIRequest) => Promise<AIResponse>,
  options: TurnReviewOptions = {}
): Promise<TurnReviewResult> {
  const { signal } = options
  if (!input.diff.trim() || signal?.aborted) return APPROVED
  const request: AIRequest = {
    model: options.model ?? '',
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: promptOf(input, options.maxDiffChars ?? DEFAULT_MAX_DIFF_CHARS) }] }],
    params: { temperature: 0, maxOutputTokens: 1_500 },
    stream: false
  }
  let onAbort: (() => void) | undefined
  try {
    const stopped = new Promise<undefined>((resolve) => {
      onAbort = () => resolve(undefined)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    const response = await Promise.race([send(request), stopped])
    if (!response || signal?.aborted) return APPROVED
    const result = parseReview(response.text)
    return response.usage ? { ...result, usage: response.usage } : result
  } catch {
    return APPROVED
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}
