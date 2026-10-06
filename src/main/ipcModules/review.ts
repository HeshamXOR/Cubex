import { isAbsolute } from 'node:path'
import type { ReasoningEffort, RoutingTarget } from '@core/types'
import { IPC, type PermissionMode, type ReviewComment, type ReviewScope } from '@shared/ipc'
import type { ReviewSendOverrides } from '../ChatService'
import type { IpcContext } from './context'

/**
 * Review panel calls: the hunks of what a task changed, keeping and undoing them, and sending comments back.
 * Everything the window passes is untrusted, so each argument is parsed here into exactly the shape the
 * service takes; the stores still check paths against the workspace and hashes against the disk.
 */

const MAX_PATH_LENGTH = 4096
const MAX_HUNK_IDS = 200
const MAX_MARKED_FILES = 200
const MAX_COMMENTS = 50
const MAX_COMMENT_LENGTH = 4000
const MAX_LINE = 10_000_000
const MAX_SYSTEM_PROMPT = 200_000
/** sha1 of a hunk. */
const HUNK_ID = /^[a-f0-9]{40}$/
/** sha256 of a file. */
const FILE_HASH = /^[a-f0-9]{64}$/
const REVERT_ID = /^[a-f0-9-]{36}$/
const STREAM_ID = /^[A-Za-z0-9_-]{1,128}$/
const MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypass']
const EFFORTS: readonly ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

type Fields = Record<string, unknown>

const isFields = (value: unknown): value is Fields => !!value && typeof value === 'object' && !Array.isArray(value)

function boundedString(value: unknown, max: number, what: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`The ${what} is invalid.`)
  return value
}

function workspacePath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_PATH_LENGTH || value.includes('\0') || isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new Error('Paths must be relative to the workspace.')
  }
  return value
}

function hunkIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_HUNK_IDS || !value.every((id) => typeof id === 'string' && HUNK_ID.test(id))) {
    throw new Error(`Hunk ids must be a list of 1 to ${MAX_HUNK_IDS} hunk ids.`)
  }
  return [...new Set(value as string[])]
}

function parseScope(value: unknown): ReviewScope {
  if (!isFields(value)) throw new Error('The review scope is invalid.')
  switch (value.kind) {
    case 'session': return { kind: 'session' }
    case 'uncommitted': return { kind: 'uncommitted' }
    case 'turn': return { kind: 'turn', messageId: boundedString(value.messageId, 256, 'message id') }
    case 'branch': {
      const base = boundedString(value.base, 256, 'branch')
      // A branch name never starts with a dash; one that does would read as an option wherever it reaches git.
      if (base.startsWith('-')) throw new Error('The branch is invalid.')
      return { kind: 'branch', base }
    }
    default: throw new Error('The review scope is invalid.')
  }
}

function parseRevertRequest(value: unknown): { path: string; hunkIds: string[]; expectHeadHash: string } {
  if (!isFields(value)) throw new Error('The revert request is invalid.')
  // A deleted file has no bytes to hash, so its hash is the empty string.
  if (typeof value.expectHeadHash !== 'string' || (value.expectHeadHash !== '' && !FILE_HASH.test(value.expectHeadHash))) {
    throw new Error('A valid 64-character hex hash is required.')
  }
  return { path: workspacePath(value.path), hunkIds: hunkIds(value.hunkIds), expectHeadHash: value.expectHeadHash }
}

function parseMarks(value: unknown): Array<{ path: string; hunkIds: string[]; headHash: string }> {
  if (!Array.isArray(value) || value.length > MAX_MARKED_FILES) throw new Error(`Review marks must be a list of at most ${MAX_MARKED_FILES} files.`)
  return value.map((item) => {
    if (!isFields(item) || typeof item.headHash !== 'string' || !FILE_HASH.test(item.headHash)) {
      throw new Error('Each file needs the 64-character hash of the version that was reviewed.')
    }
    return { path: workspacePath(item.path), hunkIds: hunkIds(item.hunkIds), headHash: item.headHash }
  })
}

function parseRevertId(value: unknown): string {
  if (typeof value !== 'string' || !REVERT_ID.test(value)) throw new Error('Invalid revert id.')
  return value
}

function line(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_LINE) throw new Error('A comment needs a line number of 1 or more.')
  return value
}

function parseComment(value: unknown): ReviewComment {
  if (!isFields(value)) throw new Error('A comment is invalid.')
  const text = typeof value.text === 'string' ? value.text.trim() : ''
  if (!text || text.length > MAX_COMMENT_LENGTH) throw new Error(`A comment needs 1 to ${MAX_COMMENT_LENGTH} characters of text.`)
  if (value.side !== 'old' && value.side !== 'new') throw new Error('A comment is on the old or the new side of the diff.')
  const startLine = line(value.startLine)
  const endLine = line(value.endLine)
  if (endLine < startLine) throw new Error('A comment cannot end before it starts.')
  if (value.hunkId !== undefined && (typeof value.hunkId !== 'string' || !HUNK_ID.test(value.hunkId))) throw new Error('A comment names a hunk that does not exist.')
  return {
    id: boundedString(value.id, 128, 'comment id'),
    path: workspacePath(value.path),
    startLine, endLine, side: value.side,
    ...(value.hunkId ? { hunkId: value.hunkId } : {}),
    text
  }
}

function parseComments(value: unknown): ReviewComment[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_COMMENTS) throw new Error(`Send between 1 and ${MAX_COMMENTS} comments at a time.`)
  return value.map(parseComment)
}

/** Only the model the request names is taken from its policy: retries, timeouts and fallbacks come from the app's settings. */
function parseTarget(policy: unknown): RoutingTarget {
  const primary = isFields(policy) && isFields(policy.primary) ? policy.primary : undefined
  if (!primary) throw new Error('The model for this request is invalid.')
  const params: NonNullable<RoutingTarget['params']> = {}
  if (isFields(primary.params)) {
    const { maxOutputTokens, reasoningEffort } = primary.params
    if (maxOutputTokens !== undefined) {
      if (typeof maxOutputTokens !== 'number' || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 10_000_000) throw new Error('The output limit for this request is invalid.')
      params.maxOutputTokens = maxOutputTokens
    }
    if (reasoningEffort !== undefined) {
      if (!EFFORTS.includes(reasoningEffort as ReasoningEffort)) throw new Error('The reasoning effort for this request is invalid.')
      params.reasoningEffort = reasoningEffort as ReasoningEffort
    }
  }
  return {
    providerId: boundedString(primary.providerId, 200, 'provider'),
    model: boundedString(primary.model, 300, 'model'),
    ...(Object.keys(params).length ? { params } : {})
  }
}

function parseOverrides(value: unknown): ReviewSendOverrides {
  if (!isFields(value)) throw new Error('The request settings are invalid.')
  const overrides: ReviewSendOverrides = {}
  if (value.policy !== undefined) overrides.target = parseTarget(value.policy)
  if (value.permissionMode !== undefined) {
    if (!MODES.includes(value.permissionMode as PermissionMode)) throw new Error('The permission mode is invalid.')
    overrides.permissionMode = value.permissionMode as PermissionMode
  }
  if (value.longContext !== undefined) {
    if (typeof value.longContext !== 'boolean') throw new Error('The long-context setting is invalid.')
    overrides.longContext = value.longContext
  }
  if (value.systemPrompt !== undefined) {
    if (typeof value.systemPrompt !== 'string' || value.systemPrompt.length > MAX_SYSTEM_PROMPT) throw new Error('The system prompt is invalid.')
    overrides.systemPrompt = value.systemPrompt
  }
  return overrides
}

function parseSendOptions(value: unknown): { streamId?: string; overrides?: ReviewSendOverrides } {
  if (value === undefined || value === null) return {}
  if (!isFields(value)) throw new Error('The send options are invalid.')
  if (value.streamId !== undefined && (typeof value.streamId !== 'string' || !STREAM_ID.test(value.streamId))) throw new Error('Invalid stream id.')
  return {
    ...(value.streamId !== undefined ? { streamId: value.streamId as string } : {}),
    ...(value.request !== undefined ? { overrides: parseOverrides(value.request) } : {})
  }
}

export function register(ctx: IpcContext): void {
  ctx.handle(IPC.reviewGet, (conversationId: unknown, scope: unknown) =>
    ctx.chat.getReview(ctx.taskIdArg(conversationId), parseScope(scope)))
  ctx.handle(IPC.reviewRevertHunks, (conversationId: unknown, request: unknown) =>
    ctx.chat.revertHunks(ctx.taskIdArg(conversationId), parseRevertRequest(request)))
  ctx.handle(IPC.reviewMark, (conversationId: unknown, items: unknown) =>
    ctx.chat.markReviewed(ctx.taskIdArg(conversationId), parseMarks(items)))
  ctx.handle(IPC.reviewUndo, (conversationId: unknown, revertId: unknown) =>
    ctx.chat.undoRevert(ctx.taskIdArg(conversationId), parseRevertId(revertId)))
  ctx.handle(IPC.reviewComments, (conversationId: unknown, comments: unknown, options?: unknown) =>
    ctx.chat.sendReviewComments(ctx.taskIdArg(conversationId), parseComments(comments), parseSendOptions(options)))
}
