import type { ErrorCategory } from '@core/types'
import type { PermissionAsk, PlanAsk, QuestionAsk, ToolActivity } from '@shared/ipc'

/** What the toast says. Plain sentences: no markup, because a toast shows backticks as typed. */

const EDIT_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file', 'multi_edit', 'apply_patch', 'remove_file', 'delete_file'])

/** Collapse whitespace and cut to `max` characters. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/** The files a finished tool call changed. Calls whose file cannot be named still count as one. */
export function editedPaths(tool: Pick<ToolActivity, 'id' | 'name' | 'phase' | 'title' | 'files'>): string[] {
  if (tool.phase !== 'done' || !EDIT_TOOLS.has(tool.name)) return []
  if (tool.files?.length) return tool.files.map((file) => file.path)
  const target = (tool.title ?? '').replace(/^(Write|Edit|Patch|Remove|Delete)\s+/, '').replace(/\s+\(\d+ edits?\)$/, '').trim()
  return target && !/^\d+ files$/.test(target) && target !== 'Apply patch' ? [target] : [`call:${tool.id}`]
}

const VERB_TITLE = /^(Run|Write|Edit|Patch|Fetch|Remove|Delete|Create|Commit|Apply)\b/

export function approvalBody(ask: Pick<PermissionAsk, 'title'>): string {
  const title = oneLine(ask.title, 120)
  if (!title) return 'Needs your approval to continue'
  return VERB_TITLE.test(title) ? `Needs your approval to ${title[0]!.toLowerCase()}${title.slice(1)}` : `Needs your approval: ${title}`
}

export function questionBody(ask: Pick<QuestionAsk, 'question'>): string {
  const question = oneLine(ask.question, 120)
  return question ? `Needs your answer: ${question}` : 'Needs your answer'
}

export function planBody(ask: Pick<PlanAsk, 'title' | 'plan'>): string {
  const heading = oneLine((ask.title ?? ask.plan.split(/\r?\n/).find((line) => line.trim()) ?? '').replace(/^[#>*\-\s]+/, ''), 100)
  return heading ? `Needs your review: ${heading}` : 'Needs your review of the plan'
}

export function finishedBody(filesChanged: number): string {
  if (filesChanged <= 0) return 'Finished'
  return `Finished: ${filesChanged} ${filesChanged === 1 ? 'file' : 'files'} changed`
}

const FAILURE: Record<ErrorCategory, string> = {
  AUTHENTICATION_ERROR: 'the provider rejected the API key',
  AUTHORIZATION_ERROR: 'this key cannot use this model',
  RATE_LIMIT_ERROR: 'the provider is rate limiting this key',
  INVALID_REQUEST: 'the provider rejected the request',
  MODEL_NOT_FOUND: 'the model is not available',
  CONTEXT_LENGTH: 'the conversation no longer fits in the model context',
  CONTENT_POLICY: 'the provider declined to answer',
  NETWORK_ERROR: 'Cubex could not reach the provider',
  TIMEOUT: 'the provider timed out',
  SERVER_ERROR: 'the provider returned a server error',
  STREAM_ERROR: 'the response stopped part way',
  TOOL_ERROR: 'a tool call could not be completed',
  LOCAL_RUNTIME_ERROR: 'the local runtime could not serve this model',
  INSUFFICIENT_MEMORY: 'there is not enough memory to run this model',
  UNSUPPORTED_FORMAT: 'the model cannot take one of the attachments',
  CANCELLED: 'the turn was stopped',
  UNKNOWN: 'the turn failed'
}

export function failedBody(error: { category: ErrorCategory; message?: string }): string {
  // An unclassified failure has only the provider's own words to go on.
  const detail = error.category === 'UNKNOWN' ? oneLine(error.message ?? '', 110) : ''
  return `Stopped: ${detail || FAILURE[error.category] || FAILURE.UNKNOWN}`
}

/** A session still called by its placeholder name is shown as the app instead. */
export function toastTitle(title: string | undefined): string {
  const clean = title ? oneLine(title, 80) : ''
  return !clean || clean === 'New Chat' || clean === 'New conversation' ? 'Cubex' : clean
}
