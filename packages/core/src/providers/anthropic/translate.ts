/**
 * Pure translation helpers between Cubex's unified `AIRequest` and Anthropic's
 * NATIVE Messages API shape. This does NOT route through an OpenAI shape:
 *  - `system` is a top-level string/blocks (Anthropic has no 'system' array role)
 *  - 'tool' role messages become user messages carrying `tool_result` blocks
 *  - assistant `tool_use` parts pass through as native `tool_use` blocks
 *  - `max_tokens` is REQUIRED (16,384 when the caller sets none)
 * Kept SDK-free so it is unit-testable in isolation.
 */
import { extractText } from '../../builders'
import type { StopReason, Usage } from '../../types/response'
import type { AIRequest } from '../../types/request'
import type { ContentSource, MessageContentPart } from '../../types/content'
import type { ToolChoice, ToolDefinition } from '../../types/tools'

const DEFAULT_MAX_TOKENS = 16_384

// --- Native wire shapes ---

export interface AnthText {
  type: 'text'
  text: string
}
export interface AnthImage {
  type: 'image'
  source:
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string }
}
export interface AnthToolUse {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}
export interface AnthToolResult {
  type: 'tool_result'
  tool_use_id: string
  content: Array<AnthText | AnthImage>
  is_error?: boolean
}
export type AnthBlock = AnthText | AnthImage | AnthToolUse | AnthToolResult

export interface AnthMessage {
  role: 'user' | 'assistant'
  content: AnthBlock[]
}

export interface AnthTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

export type AnthToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string }

export type AnthEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface AnthParams {
  model: string
  messages: AnthMessage[]
  max_tokens: number
  system?: string
  tools?: AnthTool[]
  tool_choice?: AnthToolChoice
  temperature?: number
  top_p?: number
  top_k?: number
  stop_sequences?: string[]
  stream?: boolean
  metadata?: { user_id?: string }
  /** Adaptive extended thinking (current models: type "adaptive"). */
  thinking?: { type: 'adaptive'; display?: 'summarized' | 'omitted' | 'updates' }
  /** Reasoning depth / token budget (GA on current models). */
  output_config?: { effort: AnthEffort }
  [key: string]: unknown
}

/**
 * Map the unified effort union to Anthropic's `output_config.effort`
 * vocabulary (`low|medium|high|xhigh|max`). `minimal` maps to `low`.
 */
export function toAnthEffort(effort: string | undefined): AnthEffort | undefined {
  switch (effort) {
    case 'minimal':
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    case 'high':
      return 'high'
    case 'xhigh':
      return 'xhigh'
    case 'max':
      return 'max'
    default:
      return undefined
  }
}

function toImageBlock(source: ContentSource): AnthImage | undefined {
  if (source.kind === 'base64') {
    return { type: 'image', source: { type: 'base64', media_type: source.mediaType, data: source.data } }
  }
  if (source.kind === 'url') {
    return { type: 'image', source: { type: 'url', url: source.url } }
  }
  // file_id: not natively representable here.
  return undefined
}

/**
 * Adapters that put their own signature in `ReasoningPart.signature` tag it
 * (`gemini:...`) so no other provider replays it. Anthropic signatures are
 * base64 and never hold a colon.
 */
function isForeignSignature(signature: string): boolean {
  return signature.includes(':')
}

/** Map unified content parts to native Anthropic content blocks. */
export function toAnthBlocks(parts: MessageContentPart[]): AnthBlock[] {
  const out: AnthBlock[] = []
  for (const part of parts) {
    switch (part.type) {
      case 'text':
        out.push({ type: 'text', text: part.text })
        break
      case 'image': {
        const block = toImageBlock(part.source)
        if (block) out.push(block)
        break
      }
      case 'tool_use':
        out.push({ type: 'tool_use', id: part.id, name: part.name, input: part.input })
        break
      case 'reasoning':
        // Only blocks Anthropic signed can be replayed; unsigned text is display-only.
        if (part.redacted) out.push({ type: 'redacted_thinking', data: part.redacted } as unknown as AnthBlock)
        else if (part.signature && !isForeignSignature(part.signature)) out.push({ type: 'thinking', thinking: part.text, signature: part.signature } as unknown as AnthBlock)
        break
      case 'tool_result': {
        const content: Array<AnthText | AnthImage> = []
        for (const c of part.content) {
          if (c.type === 'text') content.push({ type: 'text', text: c.text })
          else if (c.type === 'image') {
            const img = toImageBlock(c.source)
            if (img) content.push(img)
          }
        }
        out.push({
          type: 'tool_result',
          tool_use_id: part.toolUseId,
          content,
          ...(part.isError ? { is_error: true } : {})
        })
        break
      }
      default:
        break
    }
  }
  return out
}

/** Extract the system prompt as a plain string (schema instruction appended if needed). */
export function toAnthSystem(request: AIRequest): string | undefined {
  let system =
    request.system === undefined
      ? ''
      : typeof request.system === 'string'
        ? request.system
        : extractText(request.system)

  // Anthropic has no json_schema param. Best-effort: append the schema as an
  // instruction to the system prompt (documented deviation, not a native param).
  const rf = request.responseFormat
  if (rf && rf.type === 'json_schema') {
    const instruction = `\n\nYou must respond with a single JSON object that strictly conforms to this JSON Schema (named "${rf.name}"). Output only the JSON, with no markdown fences or commentary:\n${JSON.stringify(rf.schema)}`
    system += instruction
  } else if (rf && rf.type === 'json_object') {
    system += '\n\nYou must respond with a single valid JSON object and nothing else.'
  }

  return system.length > 0 ? system : undefined
}

/**
 * Build native message array. Consecutive same-role messages are kept separate;
 * 'system'/'developer' array roles are folded into the top-level system prompt
 * by the caller (toAnthSystem), so here we emit only user/assistant.
 * A 'tool' role becomes a `user` message carrying tool_result blocks.
 */
export function toAnthMessages(request: AIRequest): AnthMessage[] {
  const messages: AnthMessage[] = []
  for (const msg of request.messages) {
    if (msg.role === 'system' || msg.role === 'developer') {
      // Folded into top-level system; skip in the array.
      continue
    }
    const content = toAnthBlocks(msg.content)
    // A turn that held only parts Anthropic cannot take (reasoning written by
    // another provider, say) would go out empty, which the API rejects.
    if (content.length === 0) continue
    // 'tool' role messages are user messages carrying tool_result blocks.
    messages.push({ role: msg.role === 'tool' ? 'user' : msg.role, content })
  }
  return messages
}

export function toAnthTools(tools: ToolDefinition[] | undefined): AnthTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    input_schema: t.inputSchema as Record<string, unknown>
  }))
}

export function toAnthToolChoice(choice: ToolChoice | undefined): AnthToolChoice | undefined {
  if (choice === undefined) return undefined
  if (choice === 'auto') return { type: 'auto' }
  if (choice === 'required') return { type: 'any' }
  if (choice === 'none') return undefined // Anthropic omits tool_choice to disable
  if (typeof choice === 'object' && choice.type === 'tool') return { type: 'tool', name: choice.name }
  return undefined
}

/** Build a complete native Anthropic Messages request. */
export function toAnthropicParams(request: AIRequest, stream: boolean): AnthParams {
  const params = request.params ?? {}
  const body: AnthParams = {
    model: request.model,
    messages: toAnthMessages(request),
    max_tokens: params.maxOutputTokens ?? DEFAULT_MAX_TOKENS
  }

  const system = toAnthSystem(request)
  if (system) body.system = system
  const tools = toAnthTools(request.tools)
  if (tools) body.tools = tools
  const toolChoice = toAnthToolChoice(request.toolChoice)
  if (toolChoice) body.tool_choice = toolChoice

  if (params.temperature !== undefined) body.temperature = params.temperature
  if (params.topP !== undefined) body.top_p = params.topP
  if (params.topK !== undefined) body.top_k = params.topK
  if (params.stopSequences && params.stopSequences.length > 0) body.stop_sequences = params.stopSequences
  if (request.metadata?.user_id) body.metadata = { user_id: request.metadata.user_id }

  // Reasoning: adaptive thinking + effort. On current models budget_tokens is
  // rejected, so we express depth via output_config.effort instead.
  const effort = toAnthEffort(params.reasoningEffort)
  if (effort !== undefined) {
    // display:'summarized' streams readable reasoning tokens; the default
    // ('omitted' on current models) looks like a long silent pause.
    body.thinking = { type: 'adaptive', display: 'summarized' }
    body.output_config = { effort }
  }

  if (stream) body.stream = true
  return body
}

/**
 * The 400s Anthropic documents for a history that cannot carry thinking: the
 * latest assistant thinking no longer matches what the model produced, a
 * signature does not verify for this model, account or prefix, or (manual
 * extended thinking only; adaptive drops the rule) a tool turn written by
 * another provider has no leading thinking block. Messages are for people, so
 * only stable fragments are matched.
 */
const THINKING_HISTORY_ERROR =
  /Expected `thinking` or `redacted_thinking`|must start with a thinking block|`redacted_thinking` blocks in the latest assistant message cannot be modified|Invalid `signature` in `thinking` block/i

export function isThinkingHistoryError(message: string): boolean {
  return THINKING_HISTORY_ERROR.test(message)
}

const THINKING_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking'])

/**
 * The same request without thinking: no `thinking` parameter and no thinking
 * blocks in the history, which is the documented way past the 400s above. The
 * parameter is omitted rather than sent as `disabled`: Opus 5.5, Sonnet 5.5 and
 * the Fable and Mythos models reject `disabled`, while every model accepts no
 * parameter. Where thinking is on by default it stays on, and the API runs a
 * turn whose history has no thinking blocks without them. The history keeps
 * every other block. Undefined when the request holds no thinking, so there is
 * nothing to retry.
 */
export function withoutThinking(body: AnthParams): AnthParams | undefined {
  let changed = body.thinking !== undefined
  const messages: AnthMessage[] = []
  for (const message of body.messages) {
    const content = message.content.filter((block) => !THINKING_BLOCK_TYPES.has(block.type))
    if (content.length !== message.content.length) changed = true
    // A turn that was only thinking has nothing left to say.
    if (content.length > 0) messages.push(content.length === message.content.length ? message : { ...message, content })
  }
  if (!changed) return undefined
  const { thinking: _thinking, ...rest } = body
  return { ...rest, messages }
}

/** Map an Anthropic stop_reason to the unified StopReason. */
export function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'tool_use'
    default:
      return 'stop'
  }
}

export interface AnthUsage {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  /** Split of the cache writes by lifetime; the 1-hour share is billed at twice the input price. */
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null
}

function tokenCount(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Anthropic reports disjoint uncached, cache-read, and cache-write input counts.
 * Normalize their sum to the inclusive inputTokens used by context and cost UI.
 * Message deltas contain cumulative counters, so replace only present fields;
 * adding deltas would count the same cached prompt repeatedly.
 */
export function mapAnthUsage(usage: AnthUsage | null | undefined, prev?: Usage): Usage | undefined {
  if (!usage) return prev
  const out: Usage = { ...prev }
  const previousUncached = prev?.inputTokens === undefined ? undefined
    : Math.max(0, prev.inputTokens - (prev.cachedInputTokens ?? 0) - (prev.cacheWriteInputTokens ?? 0))
  const uncached = tokenCount(usage.input_tokens) ?? previousUncached
  const cached = tokenCount(usage.cache_read_input_tokens)
  const cacheWrite = tokenCount(usage.cache_creation_input_tokens)
  const cacheWrite1h = tokenCount(usage.cache_creation?.ephemeral_1h_input_tokens)
  const output = tokenCount(usage.output_tokens)
  if (cached !== undefined) out.cachedInputTokens = cached
  if (cacheWrite !== undefined) out.cacheWriteInputTokens = cacheWrite
  if (cacheWrite1h !== undefined) out.cacheWrite1hInputTokens = cacheWrite1h
  if (output !== undefined) out.outputTokens = output
  if (uncached !== undefined || out.cachedInputTokens !== undefined || out.cacheWriteInputTokens !== undefined) {
    out.inputTokens = (uncached ?? 0) + (out.cachedInputTokens ?? 0) + (out.cacheWriteInputTokens ?? 0)
  }
  if (out.inputTokens !== undefined || out.outputTokens !== undefined) {
    out.totalTokens = (out.inputTokens ?? 0) + (out.outputTokens ?? 0)
  }
  return Object.keys(out).length > 0 ? out : prev
}
