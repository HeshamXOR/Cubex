import type { AIRequest, MessageContentPart } from '@core/types'
import type { ContextUsageDetail, ContextUsageSection, ContextUsageSnapshot } from '@shared/ipc'
import { anchoredContextTokens, type AnchorReport } from './contextAnchor'
import { isSummaryMessageText } from './contextHistory'

export interface ContextSystemSource {
  id: string
  label: string
  /** Exact prompt chunk, including its delimiters. */
  text: string
}

export interface ContextUsageOptions {
  provider?: string
  contextWindow?: number
  measuredInputTokens?: number
  /** The anchor for this task, so the snapshot reports the same number the compaction decision uses. */
  anchor?: AnchorReport
  systemSources?: readonly ContextSystemSource[]
  now?: number
}

/**
 * Tokens per character by class. Deliberately conservative: this estimate
 * guards the compaction trigger, so over-counting costs an early summary while
 * under-counting costs the user a hard context-overflow error from the
 * provider. The old four-bytes-per-token rule under-counted this app's actual
 * workload by 15-40 percent, because source code and JSON tokenize at roughly
 * 2.5-3.5 bytes per token and CJK takes three UTF-8 bytes but about one token
 * per character.
 *
 * Punctuation rarely merges with its neighbours, runs of indentation usually
 * do, and words average around four characters per token, so the classes are
 * rated separately rather than averaged over bytes.
 */
const ALNUM_TOKENS = 0.27
/** Text with almost no whitespace is machine-generated (minified JSON, base64); its runs do not tokenize as words. */
const DENSE_ALNUM_TOKENS = 0.32
const WHITESPACE_TOKENS = 0.15
const PUNCTUATION_TOKENS = 0.6
/** Roughly one token per CJK character; a surrogate pair counts twice, which is about right for emoji. */
const NON_ASCII_TOKENS = 1
const DENSE_WHITESPACE_RATIO = 0.05
const DENSE_MIN_LENGTH = 64
/** Above this, classify fixed windows and scale. Keeps whole-file tool results cheap and the result deterministic. */
const SAMPLE_THRESHOLD = 65_536
const SAMPLE_WINDOW = 16_384

interface CharClasses {
  alnum: number
  whitespace: number
  punctuation: number
  nonAscii: number
}

function classify(text: string, from: number, to: number, into: CharClasses): void {
  for (let index = from; index < to; index++) {
    const code = text.charCodeAt(index)
    if (code > 127) into.nonAscii++
    else if (code === 32 || (code >= 9 && code <= 13)) into.whitespace++
    else if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) into.alnum++
    else into.punctuation++
  }
}

/**
 * A cheap cross-provider estimate, biased to over-count. This is deliberately
 * not a tokenizer claim; `contextAnchor` corrects it against the provider's own
 * reported input count as soon as one is available.
 */
export function estimateTextTokens(text: string): number {
  if (!text.length) return 0
  const counts: CharClasses = { alnum: 0, whitespace: 0, punctuation: 0, nonAscii: 0 }
  let sampled = text.length
  if (text.length > SAMPLE_THRESHOLD) {
    const middle = Math.floor((text.length - SAMPLE_WINDOW) / 2)
    classify(text, 0, SAMPLE_WINDOW, counts)
    classify(text, middle, middle + SAMPLE_WINDOW, counts)
    classify(text, text.length - SAMPLE_WINDOW, text.length, counts)
    sampled = SAMPLE_WINDOW * 3
  } else {
    classify(text, 0, text.length, counts)
  }
  const dense = text.length >= DENSE_MIN_LENGTH && counts.whitespace / sampled < DENSE_WHITESPACE_RATIO
  const tokens = counts.alnum * (dense ? DENSE_ALNUM_TOKENS : ALNUM_TOKENS) +
    counts.whitespace * WHITESPACE_TOKENS +
    counts.punctuation * PUNCTUATION_TOKENS +
    counts.nonAscii * NON_ASCII_TOKENS
  return Math.ceil(tokens * (text.length / sampled))
}

/** Tokens every message costs beyond its content: role markers and delimiters. */
export const MESSAGE_FRAMING_TOKENS = 4

function finiteCount(value: number | undefined, allowZero = false): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < (allowZero ? 0 : 1)) return undefined
  return Math.floor(value)
}

/**
 * The window a request can actually use. A model flagged with the gated 1M
 * beta keeps its ordinary 200K window until the user enables that header.
 */
export function effectiveContextWindow(
  model: { contextWindow?: number; longContextBeta?: boolean } | undefined,
  longContextEnabled: boolean
): number | undefined {
  const window = finiteCount(model?.contextWindow)
  if (window === undefined) return undefined
  return model?.longContextBeta && !longContextEnabled ? Math.min(window, 200_000) : window
}

/** Headroom over the reserved output for request framing the estimate cannot see. */
export const CONTEXT_SAFETY_MARGIN_TOKENS = 2_048
/** Floor for the input budget when a model's output cap is as large as its window. */
const MIN_INPUT_BUDGET_SHARE = 0.25

/**
 * Room the request itself may occupy. Input and output share the window and a
 * reasoning model's thinking counts toward its output cap, so a 200K model
 * allowed to emit 64K still overflows at 80 percent of the raw window. An
 * unknown output limit reserves nothing: there is no honest number to subtract.
 */
export function effectiveInputBudget(contextWindow: number, maxOutputTokens: number | undefined): number {
  if (maxOutputTokens === undefined || !Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) return contextWindow
  const budget = contextWindow - maxOutputTokens - CONTEXT_SAFETY_MARGIN_TOKENS
  // A cap at or beyond the window would leave nothing; keep a usable floor so
  // the ratio stays finite and compaction simply triggers as early as it can.
  return budget > 0 ? budget : Math.max(1, Math.floor(contextWindow * MIN_INPUT_BUDGET_SHARE))
}

function addText(section: ContextUsageDetail, text: string): void {
  section.estimatedTokens += estimateTextTokens(text)
  section.characters = (section.characters ?? 0) + text.length
}

/**
 * Split the already-counted system total. Largest-remainder allocation keeps
 * subrows equal to the parent despite integer rounding. Sources are accepted
 * only when they reconstruct the exact request prompt, avoiding double counts.
 */
function systemDetails(system: string, sources: readonly ContextSystemSource[], tokens: number): ContextUsageDetail[] | undefined {
  if (!sources.length || sources.map((source) => source.text).join('') !== system) return undefined
  const groups = new Map<string, { label: string; text: string }>()
  for (const source of sources) {
    const group = groups.get(source.id)
    if (group) group.text += source.text
    else groups.set(source.id, { label: source.label, text: source.text })
  }
  const totalBytes = Buffer.byteLength(system, 'utf8')
  if (!totalBytes) return undefined
  const rows = [...groups].map(([id, value]) => {
    const share = tokens * Buffer.byteLength(value.text, 'utf8') / totalBytes
    return { id, label: value.label, characters: value.text.length, estimatedTokens: Math.floor(share), remainder: share % 1 }
  })
  let remaining = tokens - rows.reduce((sum, row) => sum + row.estimatedTokens, 0)
  for (const row of [...rows].sort((a, b) => b.remainder - a.remainder)) {
    if (remaining-- <= 0) break
    row.estimatedTokens++
  }
  return rows.map(({ remainder: _remainder, ...row }) => row)
}

/**
 * Account for the normalized request sent to an adapter. Provider-specific
 * serialization and multimodal tokenization can differ; usage reported by the
 * provider remains a separate measurement. Binary/base64 bytes are never
 * tokenized as prose or assigned a made-up image/audio/video token cost.
 */
export function estimateContextUsage(request: AIRequest, options: ContextUsageOptions = {}): ContextUsageSnapshot {
  const sections: ContextUsageSection[] = [
    { id: 'system', label: 'System instructions', estimatedTokens: 0, count: 0, characters: 0 },
    { id: 'conversation', label: 'Conversation', estimatedTokens: 0, count: 0, characters: 0 },
    { id: 'toolResults', label: 'Tool results', estimatedTokens: 0, count: 0, characters: 0 },
    { id: 'tools', label: 'Built-in tool definitions', estimatedTokens: 0, count: 0, characters: 0 },
    { id: 'mcp', label: 'MCP tool definitions', estimatedTokens: 0, count: 0, characters: 0 },
    { id: 'attachments', label: 'Attachments', estimatedTokens: 0, count: 0, characters: 0 }
  ]
  const byId = Object.fromEntries(sections.map((section) => [section.id, section])) as Record<ContextUsageSection['id'], ContextUsageSection>
  const media = new Map<string, ContextUsageDetail>()
  const servers = new Map<string, ContextUsageDetail>()
  let attachmentEstimateIncomplete = false
  /** The compaction summary at the head of the request, reported apart from the recent messages. */
  let summaryRow: ContextUsageDetail | undefined

  const accountPart = (part: MessageContentPart, destination: ContextUsageSection): void => {
    switch (part.type) {
      case 'text': {
        if (part.attachment?.kind !== 'text_file') {
          addText(destination, part.text)
          break
        }
        const attachments = byId.attachments
        attachments.count!++
        addText(attachments, part.text)
        const row = media.get('text_file') ?? { id: 'text_file', label: 'Text files', estimatedTokens: 0, characters: 0, count: 0 }
        row.count!++
        addText(row, part.text)
        media.set('text_file', row)
        break
      }
      case 'reasoning':
        addText(destination, part.text)
        break
      case 'tool_use':
        // Tool names, arguments, ids and framing are input context too.
        addText(destination, JSON.stringify(part))
        break
      case 'tool_result': {
        const results = byId.toolResults
        results.count!++
        addText(results, JSON.stringify({ type: part.type, toolUseId: part.toolUseId, ...(part.isError ? { isError: true } : {}) }))
        for (const content of part.content) accountPart(content, results)
        break
      }
      case 'image':
      case 'file':
      case 'audio':
      case 'video': {
        byId.attachments.count!++
        attachmentEstimateIncomplete = true
        const labels = { image: 'Images', file: 'Files', audio: 'Audio', video: 'Video' }
        const row = media.get(part.type) ?? { id: part.type, label: labels[part.type], estimatedTokens: 0, count: 0 }
        row.count!++
        media.set(part.type, row)
        break
      }
    }
  }

  if (typeof request.system === 'string' && request.system.length) {
    addText(byId.system, request.system)
    byId.system.estimatedTokens += MESSAGE_FRAMING_TOKENS
    byId.system.count!++
    const details = systemDetails(request.system, options.systemSources ?? [], byId.system.estimatedTokens)
    if (details) byId.system.details = details
  } else if (Array.isArray(request.system) && request.system.length) {
    byId.system.estimatedTokens += MESSAGE_FRAMING_TOKENS
    byId.system.count!++
    for (const part of request.system) accountPart(part, byId.system)
  }

  for (const message of request.messages) {
    const isSystem = message.role === 'system' || message.role === 'developer'
    const destination = isSystem ? byId.system : message.role === 'tool' ? byId.toolResults : byId.conversation
    const beforeTokens = destination.estimatedTokens
    const beforeCharacters = destination.characters ?? 0
    destination.estimatedTokens += MESSAGE_FRAMING_TOKENS
    if (message.name) addText(destination, message.name)
    // A result block is counted by accountPart; plain legacy tool messages are
    // counted here. Conversation counts include assistant tool-call messages.
    if (message.role !== 'tool' || !message.content.some((part) => part.type === 'tool_result')) destination.count!++
    for (const part of message.content) accountPart(part, destination)
    if (isSystem && byId.system.details) {
      let history = byId.system.details.find((row) => row.id === 'history')
      if (!history) {
        history = { id: 'history', label: 'System messages', estimatedTokens: 0, characters: 0, count: 0 }
        byId.system.details.push(history)
      }
      history.estimatedTokens += destination.estimatedTokens - beforeTokens
      history.characters! += (destination.characters ?? 0) - beforeCharacters
      history.count!++
    }
    const first = message.content[0]
    if (!summaryRow && message.role === 'user' && first?.type === 'text' && isSummaryMessageText(first.text)) {
      summaryRow = {
        id: 'summary', label: 'Conversation summary', count: 1,
        estimatedTokens: destination.estimatedTokens - beforeTokens,
        characters: (destination.characters ?? 0) - beforeCharacters
      }
    }
  }
  // A detail row, not a new section: existing consumers key their icons by section id.
  if (summaryRow) {
    const conversation = byId.conversation
    conversation.details = [summaryRow, {
      id: 'messages', label: 'Recent messages', count: (conversation.count ?? 1) - 1,
      estimatedTokens: conversation.estimatedTokens - summaryRow.estimatedTokens,
      characters: (conversation.characters ?? 0) - (summaryRow.characters ?? 0)
    }]
  }

  for (const tool of request.tools ?? []) {
    const isMcp = tool.name.startsWith('mcp__')
    const destination = isMcp ? byId.mcp : byId.tools
    const schema = JSON.stringify(tool)
    destination.count!++
    addText(destination, schema)
    if (isMcp) {
      const server = tool.name.slice(5).split('__')[0] || 'unknown'
      const detail = servers.get(server) ?? { id: server, label: server, estimatedTokens: 0, characters: 0, count: 0 }
      addText(detail, schema)
      detail.count!++
      servers.set(server, detail)
    }
  }
  if (servers.size) byId.mcp.details = [...servers.values()]
  if (media.size) byId.attachments.details = [...media.values()]
  const outputReserve = finiteCount(request.params?.maxOutputTokens)
  const contextWindow = finiteCount(options.contextWindow)
  const measuredInputTokens = finiteCount(options.measuredInputTokens, true)
  const estimatedTokens = sections.reduce((sum, section) => sum + section.estimatedTokens, 0)
  // The working number: the provider's last reported input count plus an
  // estimate of what was appended after it, or the pure estimate when there is
  // no report to anchor on. `estimatedTokens` stays the sum of the sections.
  const anchored = anchoredContextTokens(estimatedTokens, options.anchor)
  return {
    sections,
    estimatedTokens,
    contextTokens: anchored.tokens,
    contextBasis: anchored.basis,
    ...(anchored.anchorTokens !== undefined ? { anchorTokens: anchored.anchorTokens } : {}),
    ...(anchored.appendedTokens !== undefined ? { appendedTokens: anchored.appendedTokens } : {}),
    outputReserve: outputReserve ?? 0,
    outputReserveKnown: outputReserve !== undefined,
    ...(contextWindow !== undefined ? { contextWindow, inputBudget: effectiveInputBudget(contextWindow, outputReserve) } : {}),
    ...(measuredInputTokens !== undefined ? { measuredInputTokens } : {}),
    ...(attachmentEstimateIncomplete ? { attachmentEstimateIncomplete: true } : {}),
    ...(options.provider ? { provider: options.provider } : {}),
    model: request.model,
    updatedAt: options.now ?? Date.now()
  }
}
