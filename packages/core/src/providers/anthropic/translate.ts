/**
 * Pure translation helpers between Cubex's unified `AIRequest` and Anthropic's
 * NATIVE Messages API shape. This does NOT route through an OpenAI shape:
 *  - `system` is a top-level string/blocks (Anthropic has no 'system' array role)
 *  - 'tool' role messages become user messages carrying `tool_result` blocks
 *  - assistant `tool_use` parts pass through as native `tool_use` blocks
 *  - `max_tokens` is REQUIRED (defaults to 4096)
 * Kept SDK-free so it is unit-testable in isolation.
 */
import { extractText } from '../../builders'
import type { StopReason, Usage } from '../../types/response'
import type { AIRequest } from '../../types/request'
import type { ContentSource, MessageContentPart } from '../../types/content'
import type { ToolChoice, ToolDefinition } from '../../types/tools'

const DEFAULT_MAX_TOKENS = 4096

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
  thinking?: { type: 'adaptive' }
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
    if (msg.role === 'tool') {
      messages.push({ role: 'user', content: toAnthBlocks(msg.content) })
      continue
    }
    messages.push({ role: msg.role, content: toAnthBlocks(msg.content) })
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
    body.thinking = { type: 'adaptive' }
    body.output_config = { effort }
  }

  if (stream) body.stream = true
  return body
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
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number | null
}

/** Merge Anthropic usage counts (message_start carries input, message_delta carries output). */
export function mapAnthUsage(usage: AnthUsage | null | undefined, prev?: Usage): Usage | undefined {
  if (!usage) return prev
  const out: Usage = { ...prev }
  if (usage.input_tokens !== undefined) out.inputTokens = usage.input_tokens
  if (usage.output_tokens !== undefined) out.outputTokens = usage.output_tokens
  if (usage.cache_read_input_tokens != null) out.cachedInputTokens = usage.cache_read_input_tokens
  if (out.inputTokens !== undefined || out.outputTokens !== undefined) {
    out.totalTokens = (out.inputTokens ?? 0) + (out.outputTokens ?? 0)
  }
  return Object.keys(out).length > 0 ? out : prev
}
