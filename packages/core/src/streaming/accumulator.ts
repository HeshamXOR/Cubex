import { nanoid } from 'nanoid'
import type {
  AIResponse,
  AIStreamEvent,
  MessageContentPart,
  StopReason,
  ToolCall,
  Usage
} from '../types'

interface ToolCallDraft {
  id?: string
  name?: string
  args: string
}

/**
 * One content block, recorded where it arrived. Providers stream blocks one at a
 * time in index order, so arrival order IS block order. Keeping it matters for
 * Anthropic: a signed thinking block is only valid in the position it was
 * produced, so [thinking, tool_use, thinking, tool_use] must replay as such.
 */
type Segment =
  | { kind: 'text'; text: string }
  /** `open` until a signature closes the block; later deltas then start a new block. */
  | { kind: 'reasoning'; text: string; signature?: string; redacted?: string; open: boolean }
  | { kind: 'draft'; index: number }
  | { kind: 'call'; toolCall: ToolCall }

/**
 * Consumes normalized `AIStreamEvent`s and builds the final `AIResponse`.
 * Also used to synthesize a non-streaming response from a stream.
 */
export class StreamAccumulator {
  private text = ''
  /** Content blocks in the order they arrived. */
  private readonly segments: Segment[] = []
  private readonly toolCalls: ToolCall[] = []
  private readonly toolDrafts = new Map<number, ToolCallDraft>()
  private usage: Usage | undefined
  private stopReason: StopReason = 'unknown'
  private requestId: string | undefined
  private readonly startedAt = Date.now()
  private firstTokenAt: number | undefined

  constructor(
    private readonly provider: string,
    private readonly model: string
  ) {}

  push(event: AIStreamEvent): void {
    switch (event.type) {
      case 'start':
        if (event.requestId) this.requestId = event.requestId
        break
      case 'text_delta': {
        if (this.firstTokenAt === undefined) this.firstTokenAt = Date.now()
        this.text += event.text
        if (!event.text) break
        const last = this.segments[this.segments.length - 1]
        if (last?.kind === 'text') last.text += event.text
        else this.segments.push({ kind: 'text', text: event.text })
        break
      }
      case 'reasoning_delta': {
        if (this.firstTokenAt === undefined) this.firstTokenAt = Date.now()
        const open = this.openReasoning()
        if (open) open.text += event.text
        else this.segments.push({ kind: 'reasoning', text: event.text, open: true })
        break
      }
      case 'tool_call_delta': {
        // The first delta marks where this call sits among the other blocks.
        if (!this.toolDrafts.has(event.index)) this.segments.push({ kind: 'draft', index: event.index })
        const draft = this.toolDrafts.get(event.index) ?? { args: '' }
        if (event.id) draft.id = event.id
        if (event.name) draft.name = event.name
        if (event.argsDelta) draft.args += event.argsDelta
        this.toolDrafts.set(event.index, draft)
        break
      }
      case 'tool_call':
        this.toolCalls.push(event.toolCall)
        this.segments.push({ kind: 'call', toolCall: event.toolCall })
        break
      case 'usage':
        this.usage = { ...this.usage, ...event.usage }
        break
      case 'stop':
        this.stopReason = event.stopReason
        break
      case 'metadata': {
        const block = event.data.reasoningBlock as { signature?: unknown; redacted?: unknown } | undefined
        if (typeof block?.redacted === 'string') {
          this.segments.push({ kind: 'reasoning', text: '', redacted: block.redacted, open: false })
        } else if (typeof block?.signature === 'string') {
          // A signature ends the thinking block it follows. With display omitted
          // there is no text, so the block may not exist yet.
          const open = this.openReasoning()
          if (open) {
            open.signature = block.signature
            open.open = false
          } else this.segments.push({ kind: 'reasoning', text: '', signature: block.signature, open: false })
        }
        break
      }
      case 'completed':
      case 'error':
        break
    }
  }

  /** The reasoning block still receiving deltas: only the newest block can be open. */
  private openReasoning(): Extract<Segment, { kind: 'reasoning' }> | undefined {
    const last = this.segments[this.segments.length - 1]
    return last?.kind === 'reasoning' && last.open ? last : undefined
  }

  private finalizeDraft(d: ToolCallDraft): ToolCall | undefined {
    if (!d.name) return undefined
    let input: unknown = {}
    try {
      input = d.args ? JSON.parse(d.args) : {}
    } catch {
      input = { _raw: d.args }
    }
    return { id: d.id ?? nanoid(), name: d.name, input: input as ToolCall['input'] }
  }

  finalize(): AIResponse {
    const completedAt = Date.now()
    // Explicit tool_call events win over drafts with the same id: some providers
    // emit both streaming argument deltas AND a consolidated tool_call. The call
    // keeps the position of whichever form arrived first.
    const explicit = new Map(this.toolCalls.map((tc) => [tc.id, tc]))
    const seen = new Set<string>()
    const content: MessageContentPart[] = []
    const allToolCalls: ToolCall[] = []
    const addCall = (tc: ToolCall): void => {
      if (seen.has(tc.id)) return
      seen.add(tc.id)
      allToolCalls.push(tc)
      content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
    }
    for (const seg of this.segments) {
      switch (seg.kind) {
        case 'text':
          content.push({ type: 'text', text: seg.text })
          break
        case 'reasoning':
          content.push({
            type: 'reasoning',
            text: seg.text,
            ...(seg.signature !== undefined ? { signature: seg.signature } : {}),
            ...(seg.redacted !== undefined ? { redacted: seg.redacted } : {})
          })
          break
        case 'draft': {
          const draft = this.toolDrafts.get(seg.index)
          const call = draft && this.finalizeDraft(draft)
          if (call) addCall(explicit.get(call.id) ?? call)
          break
        }
        case 'call':
          addCall(seg.toolCall)
          break
      }
    }

    const stopReason: StopReason =
      this.stopReason !== 'unknown' ? this.stopReason : allToolCalls.length > 0 ? 'tool_use' : 'stop'

    return {
      id: nanoid(),
      provider: this.provider,
      model: this.model,
      content,
      text: this.text,
      toolCalls: allToolCalls,
      stopReason,
      ...(this.usage ? { usage: this.usage } : {}),
      ...(this.requestId ? { requestId: this.requestId } : {}),
      createdAt: this.startedAt,
      timings: {
        startedAt: this.startedAt,
        ...(this.firstTokenAt ? { firstTokenAt: this.firstTokenAt, ttftMs: this.firstTokenAt - this.startedAt } : {}),
        completedAt,
        totalMs: completedAt - this.startedAt
      }
    }
  }
}
