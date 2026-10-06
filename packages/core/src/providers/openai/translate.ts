/**
 * Pure translation helpers between Cubex's unified `AIRequest` and the OpenAI
 * Chat Completions wire format. Kept free of any SDK/client dependency so they
 * can be unit-tested in isolation and reused by the `openai-compat` adapter.
 */
import { extractText } from '../../builders'
import type { StopReason, Usage } from '../../types/response'
import type { AIRequest, ReasoningEffort } from '../../types/request'
import type { MessageContentPart } from '../../types/content'
import type { ToolChoice, ToolDefinition } from '../../types/tools'

/**
 * Map the unified effort union to OpenAI's `reasoning_effort` vocabulary for a
 * given model. Newer flagships (GPT-6, GPT-5.6) accept the full low→max scale;
 * older reasoning models (GPT-5.x, o-series) top out at `high`, so `xhigh`/`max`
 * clamp down there. `minimal` is only valid on the GPT-5 family and downgrades to
 * `low` elsewhere.
 */
export function toOpenAIEffort(
  effort: ReasoningEffort | undefined,
  model: string
): 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  if (!effort) return undefined
  const extendedScale = /^gpt-(6|5\.6)/i.test(model)
  if (effort === 'xhigh' || effort === 'max') return extendedScale ? effort : 'high'
  if (effort === 'minimal') return /^gpt-5/i.test(model) ? 'minimal' : 'low'
  return effort
}

// --- Wire shapes (structural; cast to SDK params at the call boundary). ---

export interface ChatTextPart {
  type: 'text'
  text: string
}
export interface ChatImagePart {
  type: 'image_url'
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' }
}
export type ChatContentPart = ChatTextPart | ChatImagePart

export interface ChatToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'
  content?: string | ChatContentPart[] | null
  /** Assistant turns only, and only for servers whose thinking mode expects it back (see ./dialect). */
  reasoning_content?: string
  tool_calls?: ChatToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ChatTool {
  type: 'function'
  function: { name: string; description?: string; parameters: Record<string, unknown> }
}

export type ChatToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } }

export interface ChatResponseFormat {
  type: 'text' | 'json_object' | 'json_schema'
  json_schema?: { name: string; schema: Record<string, unknown>; strict?: boolean }
}

export interface ChatCompletionsBody {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  stream_options?: { include_usage: boolean }
  tools?: ChatTool[]
  tool_choice?: ChatToolChoice
  response_format?: ChatResponseFormat
  temperature?: number
  top_p?: number
  max_tokens?: number
  max_completion_tokens?: number
  stop?: string[]
  seed?: number
  presence_penalty?: number
  frequency_penalty?: number
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  metadata?: Record<string, string>
  [key: string]: unknown
}

/** Turn a Cubex content source into an OpenAI image_url string. */
function imageUrlFromSource(part: Extract<MessageContentPart, { type: 'image' }>): string | undefined {
  const src = part.source
  if (src.kind === 'url') return src.url
  if (src.kind === 'base64') return `data:${src.mediaType};base64,${src.data}`
  // file_id has no direct Chat Completions representation.
  return undefined
}

/** Map unified content parts to Chat Completions content parts (text + image). */
export function toChatContentParts(parts: MessageContentPart[]): ChatContentPart[] {
  const out: ChatContentPart[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      out.push({ type: 'text', text: part.text })
    } else if (part.type === 'image') {
      const url = imageUrlFromSource(part)
      if (url) {
        out.push({ type: 'image_url', image_url: { url, ...(part.detail ? { detail: part.detail } : {}) } })
      }
    }
    // Other modalities (audio/video/file) are dropped for the chat format.
  }
  return out
}

/** Collect assistant tool_use parts into Chat Completions tool_calls. */
function toAssistantToolCalls(parts: MessageContentPart[]): ChatToolCall[] {
  const calls: ChatToolCall[] = []
  for (const part of parts) {
    if (part.type === 'tool_use') {
      calls.push({
        id: part.id,
        type: 'function',
        function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) }
      })
    }
  }
  return calls
}

/** Serialize a tool_result part's content to the string Chat Completions expects. */
function toolResultToString(part: Extract<MessageContentPart, { type: 'tool_result' }>): string {
  const text = extractText(part.content)
  if (text) return text
  // No text parts (e.g. image-only result): fall back to a JSON description.
  try {
    return JSON.stringify(part.content)
  } catch {
    return ''
  }
}

export interface ChatMessageOptions {
  /** Echo the model's reasoning on assistant turns as `reasoning_content` (DeepSeek, Kimi). */
  reasoningContent?: boolean
}

/**
 * The reasoning to hand back to the server that produced it. Provider-signed
 * thinking (Anthropic) is bound to its provider and never leaves it, so only
 * plain reasoning text counts, in the order it was produced.
 */
function replayableReasoning(parts: MessageContentPart[]): string {
  let text = ''
  for (const part of parts) {
    if (part.type === 'reasoning' && part.signature === undefined && part.redacted === undefined) text += part.text
  }
  return text
}

/** Translate the unified messages + system prompt into Chat Completions messages. */
export function toChatMessages(request: AIRequest, options: ChatMessageOptions = {}): ChatMessage[] {
  const messages: ChatMessage[] = []

  if (request.system !== undefined) {
    const text = typeof request.system === 'string' ? request.system : extractText(request.system)
    if (text) messages.push({ role: 'system', content: text })
  }

  for (const msg of request.messages) {
    switch (msg.role) {
      case 'system':
      case 'developer': {
        const text = extractText(msg.content)
        messages.push({ role: msg.role === 'developer' ? 'developer' : 'system', content: text })
        break
      }
      case 'user': {
        const parts = toChatContentParts(msg.content)
        // Collapse a single text part to a plain string for wire compactness.
        const content =
          parts.length === 1 && parts[0]?.type === 'text' ? parts[0].text : parts
        messages.push({ role: 'user', content, ...(msg.name ? { name: msg.name } : {}) })
        break
      }
      case 'assistant': {
        const toolCalls = toAssistantToolCalls(msg.content)
        const text = extractText(msg.content)
        const entry: ChatMessage = { role: 'assistant' }
        if (text) entry.content = text
        if (toolCalls.length > 0) entry.tool_calls = toolCalls
        // An assistant turn with neither text nor tool calls still needs content.
        if (!entry.content && toolCalls.length === 0) entry.content = ''
        if (options.reasoningContent) {
          // These servers 400 on a tool-call turn that lacks the field, so a turn
          // with no reasoning to give back (written by another provider, or
          // loaded from text-only history) still carries it, empty.
          const reasoning = replayableReasoning(msg.content)
          if (reasoning || toolCalls.length > 0) entry.reasoning_content = reasoning
        }
        messages.push(entry)
        break
      }
      case 'tool': {
        // Each tool_result becomes its own `tool` message keyed by tool_use id.
        for (const part of msg.content) {
          if (part.type === 'tool_result') {
            messages.push({
              role: 'tool',
              tool_call_id: part.toolUseId,
              content: toolResultToString(part)
            })
          }
        }
        break
      }
      default:
        break
    }
  }

  return messages
}

/** Map unified tool definitions to Chat Completions function tools. */
export function toChatTools(tools: ToolDefinition[] | undefined): ChatTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: t.inputSchema as Record<string, unknown>
    }
  }))
}

/** Map unified tool choice to Chat Completions tool_choice. */
export function toChatToolChoice(choice: ToolChoice | undefined): ChatToolChoice | undefined {
  if (choice === undefined) return undefined
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice
  if (typeof choice === 'object' && choice.type === 'tool') {
    return { type: 'function', function: { name: choice.name } }
  }
  return undefined
}

/** Map unified response format to Chat Completions response_format. */
export function toChatResponseFormat(request: AIRequest): ChatResponseFormat | undefined {
  const rf = request.responseFormat
  if (!rf) return undefined
  if (rf.type === 'json_object') return { type: 'json_object' }
  if (rf.type === 'json_schema') {
    return {
      type: 'json_schema',
      json_schema: {
        name: rf.name,
        schema: rf.schema as Record<string, unknown>,
        ...(rf.strict !== undefined ? { strict: rf.strict } : {})
      }
    }
  }
  return { type: 'text' }
}

export interface ChatBodyOptions extends ChatMessageOptions {
  stream?: boolean
  /** Newer OpenAI models require `max_completion_tokens`; most compat servers use `max_tokens`. */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  /** Ask for `stream_options.include_usage` when streaming. Default true (OpenAI); see ./dialect. */
  streamUsage?: boolean
  /** Forward `request.metadata`. Default true (OpenAI); see ./dialect. */
  metadata?: boolean
  /** Forward the chosen reasoning effort. Default true; a server that refuses the field turns it off. */
  reasoningEffort?: boolean
  /**
   * Send the effort as chosen. A compatible host's levels were already checked against what its model takes, so OpenAI's
   * own clamp (max and xhigh to high) would only take away a level the model offers.
   */
  effortAsChosen?: boolean
}

/** Build a complete Chat Completions request body from the unified request. */
export function toChatCompletionsBody(request: AIRequest, options: ChatBodyOptions = {}): ChatCompletionsBody {
  const params = request.params ?? {}
  const stream = options.stream ?? request.stream ?? false
  const maxTokensField = options.maxTokensField ?? 'max_tokens'

  const body: ChatCompletionsBody = {
    model: request.model,
    messages: toChatMessages(request, options)
  }

  const tools = toChatTools(request.tools)
  if (tools) body.tools = tools
  const toolChoice = toChatToolChoice(request.toolChoice)
  if (toolChoice !== undefined) body.tool_choice = toolChoice
  const responseFormat = toChatResponseFormat(request)
  if (responseFormat) body.response_format = responseFormat

  if (params.temperature !== undefined) body.temperature = params.temperature
  if (params.topP !== undefined) body.top_p = params.topP
  if (params.maxOutputTokens !== undefined) body[maxTokensField] = params.maxOutputTokens
  if (params.stopSequences && params.stopSequences.length > 0) body.stop = params.stopSequences
  if (params.seed !== undefined) body.seed = params.seed
  if (params.presencePenalty !== undefined) body.presence_penalty = params.presencePenalty
  if (params.frequencyPenalty !== undefined) body.frequency_penalty = params.frequencyPenalty
  const effort = options.effortAsChosen ? params.reasoningEffort : toOpenAIEffort(params.reasoningEffort, request.model)
  if (effort !== undefined && options.reasoningEffort !== false) body.reasoning_effort = effort
  if (request.metadata && options.metadata !== false) body.metadata = request.metadata

  if (stream) {
    body.stream = true
    if (options.streamUsage !== false) body.stream_options = { include_usage: true }
  }

  return body
}

/** Map an OpenAI Chat Completions finish_reason to a unified StopReason. */
export function mapFinishReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'stop':
      return 'stop'
    case 'length':
      return 'length'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'content_filter':
      // NOTE: the unified StopReason union uses 'content_filter' (there is no
      // 'content_policy' member), so we map to that.
      return 'content_filter'
    default:
      return 'stop'
  }
}

/** Shape of a Chat Completions usage object (chunk or full response). */
export interface ChatUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  completion_tokens_details?: { reasoning_tokens?: number } | null
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number | null } | null
  /** OpenRouter: the amount it charged for the request, in USD. */
  cost?: number | null
  /** OpenRouter: true when the request used the caller's own upstream key. */
  is_byok?: boolean | null
  cost_details?: { upstream_inference_cost?: number | null } | null
}

function money(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * The bill the provider itself reported. With a bring-your-own-key request OpenRouter's `cost` is
 * only its fee and the upstream provider bills the rest, so that charge is added; otherwise the
 * upstream figure is informational and already inside `cost`.
 */
function reportedCost(usage: ChatUsage): number | undefined {
  const cost = money(usage.cost)
  if (cost === undefined) return undefined
  return usage.is_byok === true ? cost + (money(usage.cost_details?.upstream_inference_cost) ?? 0) : cost
}

/** Map a Chat Completions usage object to the unified Usage. */
export function mapChatUsage(usage: ChatUsage | null | undefined): Usage | undefined {
  if (!usage) return undefined
  const out: Usage = {}
  if (usage.prompt_tokens !== undefined) out.inputTokens = usage.prompt_tokens
  if (usage.completion_tokens !== undefined) out.outputTokens = usage.completion_tokens
  if (usage.total_tokens !== undefined) out.totalTokens = usage.total_tokens
  // Some providers keep a model's thinking out of `completion_tokens` and fold it into the total alone. What was
  // generated is then the total less what was sent, so a long answer is never counted short.
  if (usage.prompt_tokens !== undefined && usage.completion_tokens !== undefined && usage.total_tokens !== undefined &&
      usage.total_tokens - usage.prompt_tokens > usage.completion_tokens) {
    out.outputTokens = usage.total_tokens - usage.prompt_tokens
  }
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  if (reasoning !== undefined) out.reasoningTokens = reasoning
  const cached = usage.prompt_tokens_details?.cached_tokens
  if (cached !== undefined) out.cachedInputTokens = cached
  const cacheWrite = usage.prompt_tokens_details?.cache_write_tokens
  if (typeof cacheWrite === 'number' && Number.isSafeInteger(cacheWrite) && cacheWrite >= 0) out.cacheWriteInputTokens = cacheWrite
  const reported = reportedCost(usage)
  if (reported !== undefined) out.reportedCostUsd = reported
  return Object.keys(out).length > 0 ? out : undefined
}

// =========================================================================
// Responses API (client.responses.create) translation.
// Verified against node_modules/openai/resources/responses/responses.d.ts:
//   input items    -> EasyInputMessage { role, content: input_text|input_image }
//                     | ResponseInputItem.FunctionCallOutput { type:'function_call_output', call_id, output }
//                     | ResponseFunctionToolCall { type:'function_call', call_id, name, arguments }
//   text format    -> ResponseTextConfig { format: {type:'text'|'json_object'|'json_schema', ...} }
//   reasoning      -> Shared.Reasoning { effort }
// =========================================================================

export interface ResponsesInputText {
  type: 'input_text'
  text: string
}
export interface ResponsesInputImage {
  type: 'input_image'
  image_url?: string
  detail: 'auto' | 'low' | 'high'
}
export type ResponsesContentPart = ResponsesInputText | ResponsesInputImage

export interface ResponsesMessageItem {
  type: 'message'
  role: 'user' | 'assistant' | 'system' | 'developer'
  content: string | ResponsesContentPart[]
}
export interface ResponsesFunctionCallItem {
  type: 'function_call'
  call_id: string
  name: string
  arguments: string
}
export interface ResponsesFunctionCallOutputItem {
  type: 'function_call_output'
  call_id: string
  output: string
}
export type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem

export interface ResponsesTool {
  type: 'function'
  name: string
  description?: string
  parameters: Record<string, unknown>
  strict?: boolean
}

export type ResponsesToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; name: string }

export interface ResponsesTextConfig {
  format:
    | { type: 'text' }
    | { type: 'json_object' }
    | { type: 'json_schema'; name: string; schema: Record<string, unknown>; strict?: boolean }
}

export interface ResponsesBody {
  model: string
  input: ResponsesInputItem[]
  instructions?: string
  stream?: boolean
  tools?: ResponsesTool[]
  tool_choice?: ResponsesToolChoice
  text?: ResponsesTextConfig
  temperature?: number
  top_p?: number
  max_output_tokens?: number
  reasoning?: { effort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' }
  metadata?: Record<string, string>
  [key: string]: unknown
}

/** Map unified content parts to Responses input content parts. */
export function toResponsesContentParts(parts: MessageContentPart[]): ResponsesContentPart[] {
  const out: ResponsesContentPart[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      out.push({ type: 'input_text', text: part.text })
    } else if (part.type === 'image') {
      const url = imageUrlFromSource(part)
      if (url) out.push({ type: 'input_image', image_url: url, detail: part.detail ?? 'auto' })
    }
  }
  return out
}

/** Translate unified messages + system prompt into a Responses `input` array. */
export function toResponsesInput(request: AIRequest): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = []
  for (const msg of request.messages) {
    switch (msg.role) {
      case 'system':
      case 'developer': {
        const text = extractText(msg.content)
        items.push({ type: 'message', role: msg.role === 'developer' ? 'developer' : 'system', content: text })
        break
      }
      case 'user': {
        items.push({ type: 'message', role: 'user', content: toResponsesContentParts(msg.content) })
        break
      }
      case 'assistant': {
        const text = extractText(msg.content)
        if (text) items.push({ type: 'message', role: 'assistant', content: text })
        for (const part of msg.content) {
          if (part.type === 'tool_use') {
            items.push({
              type: 'function_call',
              call_id: part.id,
              name: part.name,
              arguments: JSON.stringify(part.input ?? {})
            })
          }
        }
        break
      }
      case 'tool': {
        for (const part of msg.content) {
          if (part.type === 'tool_result') {
            items.push({
              type: 'function_call_output',
              call_id: part.toolUseId,
              output: toolResultToString(part)
            })
          }
        }
        break
      }
      default:
        break
    }
  }
  return items
}

/** Map unified tools to Responses function tools (flat shape, not nested). */
export function toResponsesTools(tools: ToolDefinition[] | undefined): ResponsesTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    parameters: t.inputSchema as Record<string, unknown>
  }))
}

/** Map unified tool choice to a Responses tool_choice value. */
export function toResponsesToolChoice(choice: ToolChoice | undefined): ResponsesToolChoice | undefined {
  if (choice === undefined) return undefined
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice
  if (typeof choice === 'object' && choice.type === 'tool') return { type: 'function', name: choice.name }
  return undefined
}

/** Map unified response format to a Responses text config. */
export function toResponsesTextConfig(request: AIRequest): ResponsesTextConfig | undefined {
  const rf = request.responseFormat
  if (!rf) return undefined
  if (rf.type === 'json_object') return { format: { type: 'json_object' } }
  if (rf.type === 'json_schema') {
    return {
      format: {
        type: 'json_schema',
        name: rf.name,
        schema: rf.schema as Record<string, unknown>,
        ...(rf.strict !== undefined ? { strict: rf.strict } : {})
      }
    }
  }
  return { format: { type: 'text' } }
}

/** Build a complete Responses request body from the unified request. */
export function toResponsesBody(request: AIRequest, stream: boolean): ResponsesBody {
  const params = request.params ?? {}
  const body: ResponsesBody = {
    model: request.model,
    input: toResponsesInput(request)
  }

  if (request.system !== undefined) {
    const text = typeof request.system === 'string' ? request.system : extractText(request.system)
    if (text) body.instructions = text
  }

  const tools = toResponsesTools(request.tools)
  if (tools) body.tools = tools
  const toolChoice = toResponsesToolChoice(request.toolChoice)
  if (toolChoice !== undefined) body.tool_choice = toolChoice
  const text = toResponsesTextConfig(request)
  if (text) body.text = text

  if (params.temperature !== undefined) body.temperature = params.temperature
  if (params.topP !== undefined) body.top_p = params.topP
  if (params.maxOutputTokens !== undefined) body.max_output_tokens = params.maxOutputTokens
  const rEffort = toOpenAIEffort(params.reasoningEffort, request.model)
  if (rEffort !== undefined) body.reasoning = { effort: rEffort }
  if (request.metadata) body.metadata = request.metadata

  if (stream) body.stream = true
  return body
}

/** Shape of a Responses usage object. */
export interface ResponsesUsage {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  output_tokens_details?: { reasoning_tokens?: number } | null
  input_tokens_details?: { cached_tokens?: number } | null
}

/** Map a Responses usage object to the unified Usage. */
export function mapResponsesUsage(usage: ResponsesUsage | null | undefined): Usage | undefined {
  if (!usage) return undefined
  const out: Usage = {}
  if (usage.input_tokens !== undefined) out.inputTokens = usage.input_tokens
  if (usage.output_tokens !== undefined) out.outputTokens = usage.output_tokens
  if (usage.total_tokens !== undefined) out.totalTokens = usage.total_tokens
  const reasoning = usage.output_tokens_details?.reasoning_tokens
  if (reasoning !== undefined) out.reasoningTokens = reasoning
  const cached = usage.input_tokens_details?.cached_tokens
  if (cached !== undefined) out.cachedInputTokens = cached
  return Object.keys(out).length > 0 ? out : undefined
}

/** Map a Responses completion `status`/`incomplete_details` to a unified StopReason. */
export function mapResponsesStopReason(
  status: string | null | undefined,
  incompleteReason?: string | null
): StopReason {
  if (status === 'incomplete') {
    return incompleteReason === 'max_output_tokens' ? 'length' : 'stop'
  }
  if (status === 'completed') return 'stop'
  return 'stop'
}

