/**
 * Select model input without mutating the persisted transcript. A boundary must
 * point to a retained user turn; missing/stale ids safely restore full context.
 * `selectContextMessages` only moves the window. `selectContext` also returns
 * the generated summary of what the window left out, when there is one.
 */
export function selectContextMessages<T extends { id: string; role: string }>(
  messages: readonly T[],
  contextStartMessageId?: string
): readonly T[] {
  if (!contextStartMessageId) return messages
  const index = messages.findIndex((message) => message.id === contextStartMessageId && message.role === 'user')
  return index > 0 ? messages.slice(index) : messages
}

/**
 * The single place the compaction boundary and its summary are applied. The
 * summary stands in for the messages before the boundary, so it is only
 * returned when the boundary actually shortened the history: a stale boundary
 * sends every message, and then a summary of them would only duplicate them.
 */
export function selectContext<T extends { id: string; role: string }>(
  messages: readonly T[],
  contextStartMessageId?: string,
  contextSummary?: string
): { messages: readonly T[]; summary?: string } {
  const selected = selectContextMessages(messages, contextStartMessageId)
  const summary = contextSummary?.trim()
  return selected !== messages && summary ? { messages: selected, summary } : { messages: selected }
}

const SUMMARY_TAG = 'conversation_summary'
const SUMMARY_PREFACE =
  'Earlier messages in this conversation were compacted into the summary below. Treat it as background from that earlier conversation, not as a new request; the messages after it are verbatim.'

/**
 * Text of the user-role message that carries the summary at the head of the
 * request. A plain user message works with every provider.
 */
export function formatSummaryMessage(summary: string): string {
  return `${SUMMARY_PREFACE}\n<${SUMMARY_TAG}>\n${summary}\n</${SUMMARY_TAG}>`
}

/** True for text produced by `formatSummaryMessage`, so usage accounting can count it separately. */
export function isSummaryMessageText(text: string): boolean {
  return text.startsWith(SUMMARY_PREFACE) && text.includes(`<${SUMMARY_TAG}>`)
}
