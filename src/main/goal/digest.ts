import type { AIMessage, MessageContentPart } from '@core/types'

/** How much of the record of a turn the model that judges a goal is shown. The newest part is kept. */
export const DIGEST_CHARS = 12_000
const INPUT_CHARS = 240
const RESULT_CHARS = 700
const REPLY_CHARS = 1_500

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()
const cut = (text: string, chars: number): string => (text.length > chars ? `${text.slice(0, chars)}...` : text)

function inputSummary(input: unknown): string {
  if (input === null || input === undefined) return ''
  if (typeof input === 'string') return cut(oneLine(input), INPUT_CHARS)
  try { return cut(oneLine(JSON.stringify(input)), INPUT_CHARS) } catch { return '' }
}

function resultText(part: Extract<MessageContentPart, { type: 'tool_result' }>): string {
  return part.content.map((piece) => (piece.type === 'text' ? piece.text : '[image]')).join('\n')
}

/**
 * What a turn did, as plain lines for the model that judges a goal: each tool call with what it returned, and the
 * agent's closing words. This is evidence: a claim that has no line here has nothing behind it. Only the newest
 * DIGEST_CHARS are kept, because the end of a turn is where it shows whether the work held.
 */
export function digestTurn(messages: readonly AIMessage[]): string {
  const names = new Map<string, string>()
  const lines: string[] = []
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === 'tool_use') {
        names.set(part.id, part.name)
        const detail = inputSummary(part.input)
        lines.push(`- ${part.name}${detail ? ` ${detail}` : ''}`)
      } else if (part.type === 'tool_result') {
        const text = cut(oneLine(resultText(part)), RESULT_CHARS)
        lines.push(`  ${part.isError ? 'failed' : 'returned'} (${names.get(part.toolUseId) ?? 'tool'}): ${text || '(no output)'}`)
      } else if (part.type === 'text' && message.role === 'assistant' && part.text.trim()) {
        lines.push(`The agent said: ${cut(oneLine(part.text), REPLY_CHARS)}`)
      }
    }
  }
  if (lines.length === 0) return '(nothing was recorded for this turn)'
  let text = lines.join('\n')
  if (text.length > DIGEST_CHARS) text = `...\n${text.slice(text.length - DIGEST_CHARS)}`
  return text
}
