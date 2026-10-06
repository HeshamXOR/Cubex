import type {
  AIMessage,
  AIResponse,
  ImagePart,
  MessageContentPart,
  Role,
  TextPart,
  ToolCall
} from './types'

/** Build a text content part. */
export function textPart(text: string): TextPart {
  return { type: 'text', text }
}

/** Build a base64 image part. */
export function imagePart(mediaType: string, base64: string, detail?: ImagePart['detail']): ImagePart {
  return { type: 'image', source: { kind: 'base64', mediaType, data: base64 }, ...(detail ? { detail } : {}) }
}

/** Normalize a string | parts input into parts[]. */
export function toContentParts(input: string | MessageContentPart[]): MessageContentPart[] {
  return typeof input === 'string' ? [textPart(input)] : input
}

export function message(role: Role, content: string | MessageContentPart[], name?: string): AIMessage {
  return { role, content: toContentParts(content), ...(name ? { name } : {}) }
}

export const userMessage = (content: string | MessageContentPart[]): AIMessage => message('user', content)
export const assistantMessage = (content: string | MessageContentPart[]): AIMessage =>
  message('assistant', content)
export const systemMessage = (content: string | MessageContentPart[]): AIMessage => message('system', content)

/** Concatenate all text parts of a content array (ignores tool_use/reasoning). */
export function extractText(parts: MessageContentPart[]): string {
  return parts
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('')
}

/** Concatenate reasoning parts, if any. */
export function extractReasoning(parts: MessageContentPart[]): string {
  return parts
    .filter((p): p is Extract<MessageContentPart, { type: 'reasoning' }> => p.type === 'reasoning')
    .map((p) => p.text)
    .join('')
}

/**
 * The assistant message that carries one response into the next request of a
 * tool loop. Blocks keep the order the model produced them in and thinking is
 * passed back untouched: providers verify a signed block where it was generated,
 * so rebuilding the turn as "all reasoning, then text, then tool calls" is
 * rejected (400) by models that think between tool calls.
 *
 * `calls` replaces `response.toolCalls` when the caller recovered calls the model
 * wrote as text; any call without a tool_use block yet is appended.
 */
export function assistantTurn(
  response: Pick<AIResponse, 'content' | 'text' | 'toolCalls'>,
  calls: readonly ToolCall[] = response.toolCalls
): AIMessage {
  const content = response.content.filter(
    (part) => part.type === 'text' || part.type === 'reasoning' || part.type === 'tool_use'
  )
  // Hand-built responses may carry only `text` and `toolCalls`.
  if (response.text && !content.some((part) => part.type === 'text')) {
    const firstCall = content.findIndex((part) => part.type === 'tool_use')
    content.splice(firstCall < 0 ? content.length : firstCall, 0, textPart(response.text))
  }
  const present = new Set(content.flatMap((part) => (part.type === 'tool_use' ? [part.id] : [])))
  for (const call of calls) {
    if (!present.has(call.id)) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input })
  }
  return { role: 'assistant', content }
}
