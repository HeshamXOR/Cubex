import type {
  AIMessage,
  ImagePart,
  MessageContentPart,
  Role,
  TextPart
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
