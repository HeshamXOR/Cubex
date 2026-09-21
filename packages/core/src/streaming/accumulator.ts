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
 * Consumes normalized `AIStreamEvent`s and builds the final `AIResponse`.
 * Also used to synthesize a non-streaming response from a stream.
 */
export class StreamAccumulator {
  private text = ''
  private reasoning = ''
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
      case 'text_delta':
        if (this.firstTokenAt === undefined) this.firstTokenAt = Date.now()
        this.text += event.text
        break
      case 'reasoning_delta':
        if (this.firstTokenAt === undefined) this.firstTokenAt = Date.now()
        this.reasoning += event.text
        break
      case 'tool_call_delta': {
        const draft = this.toolDrafts.get(event.index) ?? { args: '' }
        if (event.id) draft.id = event.id
        if (event.name) draft.name = event.name
        if (event.argsDelta) draft.args += event.argsDelta
        this.toolDrafts.set(event.index, draft)
        break
      }
      case 'tool_call':
        this.toolCalls.push(event.toolCall)
        break
      case 'usage':
        this.usage = { ...this.usage, ...event.usage }
        break
      case 'stop':
        this.stopReason = event.stopReason
        break
      case 'completed':
      case 'metadata':
      case 'error':
        break
    }
  }

  private finalizeDrafts(): ToolCall[] {
    const fromDrafts: ToolCall[] = []
    for (const [, d] of [...this.toolDrafts.entries()].sort((a, b) => a[0] - b[0])) {
      if (!d.name) continue
      let input: unknown = {}
      try {
        input = d.args ? JSON.parse(d.args) : {}
      } catch {
        input = { _raw: d.args }
      }
      fromDrafts.push({ id: d.id ?? nanoid(), name: d.name, input: input as ToolCall['input'] })
    }
    return fromDrafts
  }

  finalize(): AIResponse {
    const completedAt = Date.now()
    // Explicit tool_call events win over drafts with the same id: some providers
    // emit both streaming argument deltas AND a consolidated tool_call.
    const explicitIds = new Set(this.toolCalls.map((tc) => tc.id))
    const draftCalls = this.finalizeDrafts().filter((tc) => !explicitIds.has(tc.id))
    const allToolCalls = [...this.toolCalls, ...draftCalls]
    const content: MessageContentPart[] = []
    if (this.reasoning) content.push({ type: 'reasoning', text: this.reasoning })
    if (this.text) content.push({ type: 'text', text: this.text })
    for (const tc of allToolCalls) {
      content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
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
