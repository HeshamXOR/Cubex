/**
 * Pure translation from Cubex's unified `AIRequest` to the NATIVE Gemini
 * `generateContent` request (not an OpenAI-shaped one):
 *  - `system` and system/developer messages become `systemInstruction`;
 *  - assistant turns are role `model`, tool results role `user` carrying
 *    `functionResponse` parts, and consecutive same-role turns are merged;
 *  - tools become `functionDeclarations` (schemas sanitized to Gemini's OpenAPI
 *    subset, see ./schema);
 *  - thought signatures are replayed verbatim on the parts they came from, which
 *    Gemini 3 requires on function calls (see ./replay for how they are stored).
 * Kept free of network and SDK code so it is unit-testable in isolation.
 */
import { extractText } from '../../builders'
import type { ContentSource, MessageContentPart } from '../../types/content'
import type { AIMessage } from '../../types/message'
import type { AIRequest } from '../../types/request'
import type { ToolChoice, ToolDefinition } from '../../types/tools'
import { GEMINI_SKIP_SIGNATURE, geminiApiCallId, unpackGeminiSignature } from './replay'
import { geminiFunctionParameters, sanitizeGeminiSchema, type GeminiSchema } from './schema'
import { geminiThinkingConfig, geminiThinkingProfile, type GeminiThinkingConfig } from './thinking'

// --- Native wire shapes (the subset this adapter reads or writes) ---

export interface GemFunctionCall {
  id?: string
  name: string
  args: Record<string, unknown>
}

export interface GemFunctionResponse {
  id?: string
  name: string
  response: Record<string, unknown>
}

export interface GemPart {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  inlineData?: { mimeType: string; data: string }
  fileData?: { fileUri: string; mimeType?: string }
  functionCall?: GemFunctionCall
  functionResponse?: GemFunctionResponse
}

export interface GemContent {
  role: 'user' | 'model'
  parts: GemPart[]
}

export interface GemFunctionDeclaration {
  name: string
  description: string
  parameters?: GeminiSchema
}

export interface GemTool {
  functionDeclarations: GemFunctionDeclaration[]
}

export interface GemToolConfig {
  functionCallingConfig: { mode: 'AUTO' | 'ANY' | 'NONE'; allowedFunctionNames?: string[] }
}

export interface GemGenerationConfig {
  temperature?: number
  topP?: number
  topK?: number
  maxOutputTokens?: number
  stopSequences?: string[]
  seed?: number
  presencePenalty?: number
  frequencyPenalty?: number
  responseMimeType?: string
  responseSchema?: GeminiSchema
  thinkingConfig?: GeminiThinkingConfig
}

export interface GemRequest {
  contents: GemContent[]
  systemInstruction?: { parts: GemPart[] }
  tools?: GemTool[]
  toolConfig?: GemToolConfig
  generationConfig?: GemGenerationConfig
}

export interface GeminiRequestOptions {
  /** The models endpoint's `thinking` flag for this model, when it is known. */
  supportsThinking?: boolean
}

const MAX_STOP_SEQUENCES = 5
const NO_RESULT = 'No result was recorded for this tool call.'

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  pdf: 'application/pdf'
}

/** Gemma is served on the Gemini API but takes neither a system instruction nor tools. */
export function isGemmaModel(model: string): boolean {
  return /^(models\/)?gemma/i.test(model)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mimeFromUrl(url: string): string | undefined {
  const path = url.split(/[?#]/)[0] ?? ''
  const dot = path.lastIndexOf('.')
  return dot < 0 ? undefined : IMAGE_TYPES[path.slice(dot + 1).toLowerCase()]
}

/** A binary or remote source as a part, or undefined when it cannot be sent. */
function mediaPart(source: ContentSource, mediaType: string | undefined): GemPart | undefined {
  switch (source.kind) {
    case 'base64': {
      const mimeType = mediaType ?? source.mediaType
      return mimeType && source.data ? { inlineData: { mimeType, data: source.data } } : undefined
    }
    case 'url': {
      const mimeType = mediaType ?? mimeFromUrl(source.url)
      return { fileData: { fileUri: source.url, ...(mimeType ? { mimeType } : {}) } }
    }
    case 'file_id': {
      // A Gemini Files API URI (https://generativelanguage.googleapis.com/v1beta/files/...).
      const mimeType = mediaType ?? source.mediaType
      return { fileData: { fileUri: source.id, ...(mimeType ? { mimeType } : {}) } }
    }
  }
}

/** Per-request bookkeeping that never reaches the wire. */
interface Ctx {
  /** tool_use id to function name, so results can name the function they answer. */
  names: Map<string, string>
  /** The tool call id behind each functionCall / functionResponse part. */
  callIds: WeakMap<GemPart, string>
}

function toolResultText(part: Extract<MessageContentPart, { type: 'tool_result' }>): string {
  return extractText(part.content)
}

function userParts(parts: MessageContentPart[], ctx: Ctx): GemPart[] {
  const out: GemPart[] = []
  // Images a tool returned follow the function responses: the response itself is JSON.
  const toolImages: GemPart[] = []
  let lastResponse = -1
  for (const part of parts) {
    switch (part.type) {
      case 'text':
        if (part.text) out.push({ text: part.text })
        break
      case 'image': {
        const media = mediaPart(part.source, undefined)
        if (media) out.push(media)
        break
      }
      case 'file':
      case 'audio':
      case 'video': {
        const media = mediaPart(part.source, part.mediaType)
        if (media) out.push(media)
        break
      }
      case 'tool_result': {
        const name = ctx.names.get(part.toolUseId)
        const text = toolResultText(part)
        if (!name) {
          // No call to answer (history was trimmed): a function response would be a 400.
          out.push({ text: `Result of an earlier tool call:\n${text}` })
          break
        }
        const apiId = geminiApiCallId(part.toolUseId)
        const response: GemPart = {
          functionResponse: {
            ...(apiId ? { id: apiId } : {}),
            name,
            response: part.isError ? { error: text } : { output: text }
          }
        }
        ctx.callIds.set(response, part.toolUseId)
        out.push(response)
        lastResponse = out.length - 1
        for (const inner of part.content) {
          if (inner.type !== 'image') continue
          const media = mediaPart(inner.source, undefined)
          if (media) toolImages.push(media)
        }
        break
      }
      default:
        break
    }
  }
  if (toolImages.length > 0) out.splice(lastResponse + 1, 0, ...toolImages)
  return out
}

function modelParts(parts: MessageContentPart[], ctx: Ctx): GemPart[] {
  const out: GemPart[] = []
  for (const part of parts) {
    switch (part.type) {
      case 'text':
        if (part.text) out.push({ text: part.text })
        break
      case 'reasoning': {
        // Only a signature Gemini issued can be replayed; plain summaries, redacted
        // blocks and other providers' signatures are display-only here.
        const signature = unpackGeminiSignature(part.signature)
        if (!signature) break
        if (part.text) {
          out.push({ text: part.text, thought: true, thoughtSignature: signature })
          break
        }
        // A bare signature belongs to the part before it (see replay.ts).
        const previous = out[out.length - 1]
        if (previous && previous.thoughtSignature === undefined && !previous.thought) previous.thoughtSignature = signature
        else out.push({ text: '', thoughtSignature: signature })
        break
      }
      case 'tool_use': {
        ctx.names.set(part.id, part.name)
        const apiId = geminiApiCallId(part.id)
        const args = isPlainObject(part.input) ? part.input : part.input === null || part.input === undefined ? {} : { value: part.input }
        const call: GemPart = { functionCall: { ...(apiId ? { id: apiId } : {}), name: part.name, args } }
        ctx.callIds.set(call, part.id)
        out.push(call)
        break
      }
      default:
        break
    }
  }
  return out
}

function mergeTurns(turns: GemContent[]): GemContent[] {
  const merged: GemContent[] = []
  for (const turn of turns) {
    const last = merged[merged.length - 1]
    if (last?.role === turn.role) last.parts.push(...turn.parts)
    else merged.push({ role: turn.role, parts: [...turn.parts] })
  }
  return merged
}

/**
 * Every call in a model turn needs exactly one response, in call order, in the
 * turn right after it; the API answers a mismatch with a 400. Results are
 * reordered to match, and a call that never got one is answered with an error.
 */
function alignResponses(contents: GemContent[], ctx: Ctx): void {
  contents.forEach((content, index) => {
    const next = contents[index + 1]
    if (content.role !== 'model' || next?.role !== 'user') return
    const calls = content.parts.filter((part) => part.functionCall)
    if (calls.length === 0) return
    const responses = new Map<string, GemPart>()
    for (const part of next.parts) {
      const id = part.functionResponse ? ctx.callIds.get(part) : undefined
      if (id !== undefined) responses.set(id, part)
    }
    const ordered: GemPart[] = []
    for (const call of calls) {
      const id = ctx.callIds.get(call)
      const found = id === undefined ? undefined : responses.get(id)
      if (found) responses.delete(id!)
      ordered.push(
        found ?? {
          functionResponse: {
            ...(call.functionCall!.id ? { id: call.functionCall!.id } : {}),
            name: call.functionCall!.name,
            response: { error: NO_RESULT }
          }
        }
      )
    }
    // Anything else in that turn (text, tool images, a stray response) follows the answers.
    const answered = new Set(ordered)
    next.parts = [...ordered, ...next.parts.filter((part) => !answered.has(part))]
  })
}

/**
 * Gemini 3 rejects a current-turn function call that lacks a signature. The model
 * always supplies one; a call it did not make (another provider's turn after a
 * fallback, or a call recovered from text) gets the documented skip value so the
 * turn can continue. Earlier turns are not validated and stay untouched.
 */
function markUnsignedCalls(contents: GemContent[]): void {
  let turnStart = -1
  contents.forEach((content, index) => {
    if (content.role === 'user' && !content.parts.some((part) => part.functionResponse)) turnStart = index
  })
  contents.forEach((content, index) => {
    if (index <= turnStart || content.role !== 'model') return
    const first = content.parts.find((part) => part.functionCall)
    if (first && first.thoughtSignature === undefined) first.thoughtSignature = GEMINI_SKIP_SIGNATURE
  })
}

/** The conversation as Gemini `contents`. System and developer messages are excluded. */
export function toGeminiContents(messages: AIMessage[], model: string): GemContent[] {
  const ctx: Ctx = { names: new Map(), callIds: new WeakMap() }
  const turns: GemContent[] = []
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') continue
    const role = message.role === 'assistant' ? 'model' : 'user'
    const parts = role === 'model' ? modelParts(message.content, ctx) : userParts(message.content, ctx)
    if (parts.length > 0) turns.push({ role, parts })
  }
  const contents = mergeTurns(turns)
  alignResponses(contents, ctx)
  if (geminiThinkingProfile(model)?.control === 'level') markUnsignedCalls(contents)
  return contents
}

/** The system prompt plus any system or developer messages, as one string. */
function systemText(request: AIRequest): string {
  const sections: string[] = []
  if (request.system !== undefined) {
    sections.push(typeof request.system === 'string' ? request.system : extractText(request.system))
  }
  for (const message of request.messages) {
    if (message.role === 'system' || message.role === 'developer') sections.push(extractText(message.content))
  }
  return sections.filter((section) => section.length > 0).join('\n\n')
}

export function toGeminiTools(tools: ToolDefinition[] | undefined): GemTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  const seen = new Set<string>()
  const declarations: GemFunctionDeclaration[] = []
  for (const tool of tools) {
    // A duplicate name is a 400 for the whole request.
    if (seen.has(tool.name)) continue
    seen.add(tool.name)
    const parameters = geminiFunctionParameters(tool.inputSchema)
    declarations.push({
      name: tool.name,
      // Required by the API; a tool without a description is described by its name.
      description: tool.description || tool.name,
      ...(parameters ? { parameters } : {})
    })
  }
  return [{ functionDeclarations: declarations }]
}

export function toGeminiToolConfig(choice: ToolChoice | undefined): GemToolConfig | undefined {
  if (choice === undefined) return undefined
  if (choice === 'auto') return { functionCallingConfig: { mode: 'AUTO' } }
  if (choice === 'none') return { functionCallingConfig: { mode: 'NONE' } }
  if (choice === 'required') return { functionCallingConfig: { mode: 'ANY' } }
  return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.name] } }
}

function toGenerationConfig(request: AIRequest, options: GeminiRequestOptions): GemGenerationConfig | undefined {
  const params = request.params ?? {}
  const config: GemGenerationConfig = {}
  if (params.temperature !== undefined) config.temperature = params.temperature
  if (params.topP !== undefined) config.topP = params.topP
  if (params.topK !== undefined) config.topK = params.topK
  if (params.maxOutputTokens !== undefined) config.maxOutputTokens = params.maxOutputTokens
  if (params.stopSequences && params.stopSequences.length > 0) config.stopSequences = params.stopSequences.slice(0, MAX_STOP_SEQUENCES)
  if (params.seed !== undefined) config.seed = params.seed
  if (params.presencePenalty !== undefined) config.presencePenalty = params.presencePenalty
  if (params.frequencyPenalty !== undefined) config.frequencyPenalty = params.frequencyPenalty

  const format = request.responseFormat
  if (format?.type === 'json_object') config.responseMimeType = 'application/json'
  if (format?.type === 'json_schema') {
    config.responseMimeType = 'application/json'
    const schema = sanitizeGeminiSchema(format.schema)
    if (schema) config.responseSchema = schema
  }

  const thinking = geminiThinkingConfig(request.model, params.reasoningEffort, options.supportsThinking)
  if (thinking) config.thinkingConfig = thinking
  return Object.keys(config).length > 0 ? config : undefined
}

/** Build a complete native Gemini request body. */
export function toGeminiRequest(request: AIRequest, options: GeminiRequestOptions = {}): GemRequest {
  const contents = toGeminiContents(request.messages, request.model)
  const body: GemRequest = { contents }

  const system = systemText(request)
  if (system) {
    if (isGemmaModel(request.model)) {
      const first = contents.find((content) => content.role === 'user')
      if (first) first.parts.unshift({ text: system })
      else contents.unshift({ role: 'user', parts: [{ text: system }] })
    } else {
      body.systemInstruction = { parts: [{ text: system }] }
    }
  }

  const tools = toGeminiTools(request.tools)
  if (tools) {
    body.tools = tools
    const toolConfig = toGeminiToolConfig(request.toolChoice)
    if (toolConfig) body.toolConfig = toolConfig
  }

  const generationConfig = toGenerationConfig(request, options)
  if (generationConfig) body.generationConfig = generationConfig
  return body
}
