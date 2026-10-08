import type { StoredMessage, ToolActivity, ToolFileActivity } from './ipc'
import { sanitizeDiagnosticsSummary } from './diagnosticsSummary'
import { sanitizePeerActivity } from './peers'

export type MessageTranscriptBlock =
  | { type: 'text'; text: string; textStart?: number; textEnd?: number }
  | { type: 'reasoning'; text: string; durationMs?: number }
  | { type: 'tool'; tool: ToolActivity }

export interface MessageTranscriptInput {
  blocks?: readonly MessageTranscriptBlock[]
  text?: string
  reasoning?: string
  reasoningMs?: number
  toolCalls?: readonly ToolActivity[]
}

export interface HydratedMessageTranscript {
  blocks?: MessageTranscriptBlock[]
  reasoning?: string
  reasoningMs?: number
  toolCalls?: ToolActivity[]
  transcriptTruncated?: boolean
}

interface TranscriptEnvelope {
  version: 1
  blocks: MessageTranscriptBlock[]
  truncated?: boolean
}

/** Bounds apply only to display metadata. StoredMessage.text remains complete. */
export const MESSAGE_TRANSCRIPT_MAX_BYTES = 1024 * 1024
export const MESSAGE_TRANSCRIPT_MAX_BLOCKS = 128
/** Per-file entries kept for one multi-file tool call; their diffs are clipped and budgeted so the block always fits. */
export const MESSAGE_TRANSCRIPT_MAX_FILES = 50
const TEXT_MAX_CHARS = 64 * 1024
const DIFF_MAX_CHARS = 64 * 1024
const FILE_DIFF_MAX_CHARS = 16 * 1024
const FILES_DIFF_TOTAL_MAX_CHARS = 128 * 1024
const encoder = new TextEncoder()
const CLIPPED = '\n… [truncated in saved history]'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function count(value: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? Math.floor(value) : undefined
}

function clip(value: unknown, limit: number, mark = true): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value.length <= limit) return value
  let text = value.slice(0, limit - (mark ? CLIPPED.length : 0))
  // Do not persist half of a UTF-16 surrogate pair at the truncation boundary.
  const last = text.charCodeAt(text.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1)
  return text + (mark ? CLIPPED : '')
}

function artifactId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined
}

/** File lists whose entries or diffs were cut while sanitizing, so the envelope can say so. */
const truncatedFileLists = new WeakSet<ToolFileActivity[]>()

/** Whitelist per-file activity: bounded count, clipped diffs, and a total diff budget. */
function sanitizeFiles(value: unknown): ToolFileActivity[] | undefined {
  if (!Array.isArray(value)) return undefined
  const files: ToolFileActivity[] = []
  let truncated = value.length > MESSAGE_TRANSCRIPT_MAX_FILES
  let diffChars = 0
  for (const item of value.slice(0, MESSAGE_TRANSCRIPT_MAX_FILES)) {
    if (!record(item)) continue
    const path = clip(item.path, 500, false)
    const status = item.status === 'added' || item.status === 'modified' || item.status === 'deleted' ? item.status : undefined
    const added = count(item.added, 1_000_000_000)
    const removed = count(item.removed, 1_000_000_000)
    if (!path || !status || added === undefined || removed === undefined) continue
    const file: ToolFileActivity = { path, status, added, removed }
    const diff = clip(item.diff, FILE_DIFF_MAX_CHARS)
    if (diff) {
      if (diff.endsWith(CLIPPED)) truncated = true
      // Late files keep their counts once the shared diff budget is spent.
      if (diffChars + diff.length <= FILES_DIFF_TOTAL_MAX_CHARS) {
        file.diff = diff
        diffChars += diff.length
      } else truncated = true
    }
    files.push(file)
  }
  if (files.length === 0) return undefined
  if (truncated) truncatedFileLists.add(files)
  return files
}

/** Whitelist display fields; raw arguments, results and arbitrary metadata stay out. */
function sanitizeTool(value: unknown, legacy = false): ToolActivity | undefined {
  if (!record(value)) return undefined
  const id = clip(value.id, 256, false)
  const name = clip(value.name, 256, false)
  if (!id || !name) return undefined
  const phase = value.phase === 'queued' || value.phase === 'running' || value.phase === 'done' || value.phase === 'error' ? value.phase : undefined
  if (!phase && !legacy) return undefined
  const tool: ToolActivity = { id, name, phase: phase ?? 'error' }
  const title = clip(value.title, 500)
  const detail = clip(value.detail, 4000)
  const diff = clip(value.diff, DIFF_MAX_CHARS)
  const added = count(value.added, 1_000_000_000)
  const removed = count(value.removed, 1_000_000_000)
  if (title) tool.title = title
  if (detail) tool.detail = detail
  if (diff) tool.diff = diff
  if (added !== undefined) tool.added = added
  if (removed !== undefined) tool.removed = removed
  const outputId = artifactId(value.outputId)
  const outputConversationId = artifactId(value.outputConversationId)
  if (outputId) tool.outputId = outputId
  if (outputId && outputConversationId) tool.outputConversationId = outputConversationId
  const files = sanitizeFiles(value.files)
  if (files) tool.files = files
  const diagnostics = sanitizeDiagnosticsSummary(value.diagnostics)
  if (diagnostics) tool.diagnostics = diagnostics
  const peer = sanitizePeerActivity(value.peer)
  if (peer) tool.peer = peer
  if (value.interrupted === true) tool.interrupted = true
  if (!phase) {
    tool.interrupted = true
    tool.detail = 'Historical tool call — completion was not recorded.'
  }
  return tool
}

function sanitizeBlock(value: unknown): MessageTranscriptBlock | undefined {
  if (!record(value)) return undefined
  if (value.type === 'tool') {
    const tool = sanitizeTool(value.tool)
    return tool ? { type: 'tool', tool } : undefined
  }
  if (value.type === 'text' || value.type === 'reasoning') {
    const text = clip(value.text, TEXT_MAX_CHARS)
    if (!text) return undefined
    if (value.type === 'text') {
      const textStart = count(value.textStart)
      const textEnd = count(value.textEnd)
      return { type: 'text', text, ...(textStart !== undefined && textEnd !== undefined && textEnd >= textStart ? { textStart, textEnd } : {}) }
    }
    const durationMs = count(value.durationMs, 7 * 24 * 3600_000)
    return { type: 'reasoning', text, ...(durationMs !== undefined ? { durationMs } : {}) }
  }
  return undefined
}

function boundedEnvelope(rawBlocks: readonly unknown[], previouslyTruncated = false): TranscriptEnvelope | undefined {
  const blocks: MessageTranscriptBlock[] = []
  let truncated = previouslyTruncated || rawBlocks.length > MESSAGE_TRANSCRIPT_MAX_BLOCKS
  // Leave room for the complete envelope, including a possible truncation flag.
  let bytes = encoder.encode('{"version":1,"blocks":[],"truncated":true}').byteLength
  for (const raw of rawBlocks.slice(0, MESSAGE_TRANSCRIPT_MAX_BLOCKS)) {
    const block = sanitizeBlock(raw)
    if (!block) continue
    const size = encoder.encode(JSON.stringify(block)).byteLength + 1
    if (bytes + size > MESSAGE_TRANSCRIPT_MAX_BYTES) {
      truncated = true
      break
    }
    bytes += size
    blocks.push(block)
    if (block.type !== 'tool' && block.text.endsWith(CLIPPED)) truncated = true
    if (block.type === 'tool' && [block.tool.title, block.tool.detail, block.tool.diff].some((field) => field?.endsWith(CLIPPED))) truncated = true
    if (block.type === 'tool' && block.tool.files && truncatedFileLists.has(block.tool.files)) truncated = true
  }
  // Text-only messages already have a complete canonical `text` column.
  if (!blocks.some((block) => block.type !== 'text')) return undefined
  return { version: 1, blocks, ...(truncated ? { truncated: true } : {}) }
}

function parseJson(raw: unknown): unknown {
  if (typeof raw !== 'string' || !raw || raw.length > MESSAGE_TRANSCRIPT_MAX_BYTES) return undefined
  if (encoder.encode(raw).byteLength > MESSAGE_TRANSCRIPT_MAX_BYTES) return undefined
  try { return JSON.parse(raw) as unknown } catch { return undefined }
}

function parseEnvelope(raw: unknown): TranscriptEnvelope | undefined {
  const parsed = parseJson(raw)
  if (!record(parsed) || parsed.version !== 1 || !Array.isArray(parsed.blocks)) return undefined
  return boundedEnvelope(parsed.blocks, parsed.truncated === true)
}

/** Serialize current display state. This never alters the live message or tool phases. */
export function serializeMessageTranscript(input: MessageTranscriptInput): string | undefined {
  let blocks: readonly unknown[] = input.blocks ?? []
  if (!blocks.length) {
    const derived: MessageTranscriptBlock[] = []
    if (input.reasoning) derived.push({ type: 'reasoning', text: input.reasoning, ...(input.reasoningMs !== undefined ? { durationMs: input.reasoningMs } : {}) })
    for (const tool of input.toolCalls ?? []) derived.push({ type: 'tool', tool })
    if (input.text) derived.push({ type: 'text', text: input.text })
    blocks = derived
  }
  // Offsets into the complete canonical column let history restore long text
  // without duplicating it in the bounded display metadata.
  let textCursor = 0
  if (input.text) blocks = blocks.map((raw) => {
    if (!record(raw) || raw.type !== 'text' || typeof raw.text !== 'string') return raw
    const start = input.text!.indexOf(raw.text, textCursor)
    if (start < 0) return raw
    textCursor = start + raw.text.length
    return { ...raw, textStart: start, textEnd: textCursor }
  })
  const envelope = boundedEnvelope(blocks)
  return envelope ? JSON.stringify(envelope) : undefined
}

/** Main-process persistence boundary: reject malformed/oversized input and retain only display fields. */
export function normalizeMessageTranscriptJson(raw: unknown): string | undefined {
  const envelope = parseEnvelope(raw)
  return envelope ? JSON.stringify(envelope) : undefined
}

function historicalTool(tool: ToolActivity, conversationId?: string): ToolActivity {
  const safe: ToolActivity = { ...tool }
  delete safe.outputConversationId
  // A JSON import receives a new task id. Never let its stored owner field grant
  // access to the original task's output artifacts; the viewer validates this id.
  const owner = artifactId(conversationId)
  if (safe.outputId && owner) safe.outputConversationId = owner
  if (safe.phase === 'queued') {
    safe.phase = 'error'
    safe.interrupted = true
    safe.detail = 'Not executed — the turn ended before this call ran.'
  } else if (safe.phase === 'running') {
    safe.phase = 'error'
    safe.interrupted = true
    safe.detail = `Interrupted — completion was not recorded.${safe.detail ? `\n${safe.detail}` : ''}`
  }
  return safe
}

/** Restore display metadata only. No tool calls/results are added to model history. */
export function hydrateMessageTranscript(
  message: Pick<StoredMessage, 'uiTranscriptJson' | 'toolCallsJson'> & { text?: string },
  conversationId?: string
): HydratedMessageTranscript {
  let envelope = parseEnvelope(message.uiTranscriptJson)
  if (!envelope) {
    const legacy = parseJson(message.toolCallsJson)
    if (Array.isArray(legacy)) {
      const blocks = legacy.slice(0, MESSAGE_TRANSCRIPT_MAX_BLOCKS)
        .map((value) => sanitizeTool(value, true))
        .filter((tool): tool is ToolActivity => tool !== undefined)
        .map((tool): MessageTranscriptBlock => ({ type: 'tool', tool }))
      envelope = boundedEnvelope(blocks, legacy.length > MESSAGE_TRANSCRIPT_MAX_BLOCKS)
    }
  }
  if (!envelope) return {}
  let textCursor = 0
  let restoredText = false
  const blocks = envelope.blocks.map((block): MessageTranscriptBlock => {
    if (block.type === 'tool') return { type: 'tool', tool: historicalTool(block.tool, conversationId) }
    if (block.type !== 'text') return block
    const display = { type: 'text' as const, text: block.text }
    if (message.text === undefined) return display
    const { textStart, textEnd } = block
    if (textStart === undefined || textEnd === undefined || textStart < textCursor || textEnd > message.text.length) return display
    const text = message.text.slice(textStart, textEnd)
    // Imported metadata cannot substitute unrelated canonical text for a block.
    if (text !== block.text && !(block.text.endsWith(CLIPPED) && text.startsWith(block.text.slice(0, -CLIPPED.length)))) return display
    textCursor = textEnd
    restoredText = true
    return { type: 'text', text }
  })
  if (envelope.truncated && message.text) {
    if (restoredText) {
      const remainder = message.text.slice(textCursor).trimStart()
      if (remainder) blocks.push({ type: 'text', text: remainder })
    } else {
      // Older envelopes have no offsets. Preserve the full answer once when
      // the original ordering cannot be recovered from clipped metadata.
      blocks.splice(0, blocks.length, ...blocks.filter((block) => block.type !== 'text'), { type: 'text', text: message.text })
    }
  }
  const reasoning = blocks.filter((block): block is Extract<MessageTranscriptBlock, { type: 'reasoning' }> => block.type === 'reasoning')
  const toolCalls = blocks.filter((block): block is Extract<MessageTranscriptBlock, { type: 'tool' }> => block.type === 'tool').map((block) => block.tool)
  return {
    blocks,
    ...(reasoning.length ? { reasoning: reasoning.map((block) => block.text).join('\n\n') } : {}),
    ...(reasoning.length && reasoning.every((block) => block.durationMs !== undefined)
      ? { reasoningMs: reasoning.reduce((sum, block) => sum + block.durationMs!, 0) } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(envelope.truncated ? { transcriptTruncated: true } : {})
  }
}

/** Ordered metadata is authoritative; legacy activity has no recorded ordering. */
export function messageDisplayBlocks(input: MessageTranscriptInput): MessageTranscriptBlock[] {
  if (input.blocks?.length) {
    const blocks = [...input.blocks]
    if (input.text && !blocks.some((block) => block.type === 'text')) blocks.push({ type: 'text', text: input.text })
    return blocks
  }
  return [
    ...(input.reasoning ? [{ type: 'reasoning' as const, text: input.reasoning, ...(input.reasoningMs !== undefined ? { durationMs: input.reasoningMs } : {}) }] : []),
    ...(input.toolCalls ?? []).map((tool): MessageTranscriptBlock => ({ type: 'tool', tool })),
    ...(input.text ? [{ type: 'text' as const, text: input.text }] : [])
  ]
}
