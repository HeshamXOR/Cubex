import type { AIMessage, MessageContentPart } from '@core/types'
import { PRUNE_PROTECTED_TOOLS } from './compaction'

/**
 * Shortens older tool results in what is sent to the model, more the older they are, once the context has filled up. The
 * newest results stay whole and every shortened one keeps its start and end, so a long agent run does not spend its window
 * on logs and files it has moved past. Controlled studies (arXiv 2608.26218, 2508.21433) credit this kind of plain rule with
 * large gains on small windows and with lower cost at no loss elsewhere, and the rule itself makes no model call.
 *
 * Only the outgoing copy changes. The turn's record keeps the full text. A provider's prompt cache is the reason caps are
 * sticky: a result keeps the cap it was given until a new pass, and a pass only happens when it frees enough to pay for the
 * cache entries it invalidates. Between passes the prompt prefix is byte-identical.
 */

/** Below this share of the window nothing is touched, so a short task on any model never sees this. */
const START_FILL = 0.5
/** The newest results are what the model is working from. */
const KEEP_NEWEST = 4
const FIRST_CAP_CHARS = 8_000
const SMALLEST_CAP_CHARS = 500
/** New results to wait for between passes. */
const RESULTS_BETWEEN_PASSES = 8
const MIN_RECLAIM_CHARS = 4_000
/** Roughly how many characters a token is, for sizing what a pass must free against the window. */
const CHARS_PER_TOKEN = 3.5
const MIN_RECLAIM_WINDOW_SHARE = 0.05

/** The cap halves each time a result's age doubles, counted in tool results after it. */
export function capForAge(age: number): number {
  if (age < KEEP_NEWEST) return Number.POSITIVE_INFINITY
  return Math.max(SMALLEST_CAP_CHARS, FIRST_CAP_CHARS / 2 ** Math.floor(Math.log2(age / KEEP_NEWEST)))
}

/**
 * Keep the start and end of a text. A command's end is where a build or test run says what failed, so most of its share
 * goes there. Other output is read from the top.
 */
export function shortened(text: string, cap: number, toolName: string | undefined): string {
  if (text.length <= cap) return text
  const tailShare = toolName === 'run_command' ? 0.8 : 0.4
  const tail = Math.floor(cap * tailShare)
  const head = cap - tail
  const cut = text.length - head - tail
  return `${text.slice(0, head)}\n[... ${cut} characters of this older tool result were cut to save room. Read the file or run the command again if you need them.]\n${text.slice(text.length - tail)}`
}

const textOf = (part: Extract<MessageContentPart, { type: 'tool_result' }>): number =>
  part.content.reduce((sum, item) => sum + (item.type === 'text' ? item.text.length : 0), 0)

export class ToolResultAger {
  /** The cap each result has been given. */
  private readonly caps = new Map<string, number>()
  private resultsAtLastPass = 0

  /** What to send for these messages at this fill. The same array comes back while nothing is shortened. */
  apply(messages: AIMessage[], fill: number, windowTokens: number): AIMessage[] {
    if (fill >= START_FILL) this.pass(messages, windowTokens)
    if (this.caps.size === 0) return messages
    const names = toolNames(messages)
    let changed = false
    const sent = messages.map((message) => {
      if (message.role !== 'tool') return message
      const content = message.content.map((part) => {
        const cap = part.type === 'tool_result' ? this.caps.get(part.toolUseId) : undefined
        if (part.type !== 'tool_result' || cap === undefined || textOf(part) <= cap) return part
        changed = true
        return {
          ...part,
          content: part.content.map((item) => (item.type === 'text' ? { ...item, text: shortened(item.text, cap, names.get(part.toolUseId)) } : item))
        }
      })
      return { ...message, content }
    })
    return changed ? sent : messages
  }

  private pass(messages: AIMessage[], windowTokens: number): void {
    const results = messages.flatMap((message) => (message.role === 'tool' ? message.content.filter((part): part is Extract<MessageContentPart, { type: 'tool_result' }> => part.type === 'tool_result') : []))
    if (this.caps.size > 0 && results.length - this.resultsAtLastPass < RESULTS_BETWEEN_PASSES) return
    const names = toolNames(messages)
    const next = new Map(this.caps)
    let reclaimed = 0
    results.forEach((part, index) => {
      const name = names.get(part.toolUseId)
      if (name && PRUNE_PROTECTED_TOOLS.has(name)) return
      const age = results.length - 1 - index
      const before = Math.min(this.caps.get(part.toolUseId) ?? Number.POSITIVE_INFINITY, textOf(part))
      const cap = Math.min(capForAge(age), this.caps.get(part.toolUseId) ?? Number.POSITIVE_INFINITY)
      if (cap >= before) return
      next.set(part.toolUseId, cap)
      reclaimed += before - cap
    })
    const worthIt = Math.max(MIN_RECLAIM_CHARS, windowTokens * CHARS_PER_TOKEN * MIN_RECLAIM_WINDOW_SHARE)
    if (reclaimed < worthIt) return
    for (const [id, cap] of next) this.caps.set(id, cap)
    this.resultsAtLastPass = results.length
  }
}

function toolNames(messages: AIMessage[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const part of message.content) if (part.type === 'tool_use') names.set(part.id, part.name)
  }
  return names
}
