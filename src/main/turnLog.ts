import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AIMessage, JSONValue, MessageContentPart, TextPart, ToolResultPart } from '@core/types'
import { stripXmlToolMarkup } from '@core/tools/xmlToolCalls'

/**
 * What the model did during a turn: the tool calls it made and what came back, kept per task so the turns that
 * follow can see them. A stored conversation only holds the text of each answer, and a model that finds earlier
 * replies saying "I created the file" with no sign of a tool call behind them learns to do the same: it
 * narrates work instead of doing it. The record is what the model produced, shortened where output was long.
 */

interface Clip {
  /** Longest text kept in a tool result. */
  result: number
  /** Longest string kept inside a tool call's arguments. */
  input: number
  /** Longest text kept in an assistant message. */
  text: number
}

/** Tried in order until the turn fits: whole-ish, then short, then only the outline of each call. */
const CLIPS: readonly Clip[] = [
  { result: 6_000, input: 2_000, text: 12_000 },
  { result: 1_200, input: 500, text: 6_000 },
  { result: 0, input: 200, text: 2_000 }
]
const MAX_TURN_CHARACTERS = 96_000
const MAX_TURNS_PER_TASK = 200
const MAX_FILE_BYTES = 3_000_000
const MAX_DEPTH = 8
const STOPPED_NOTE = '[This turn was stopped before the assistant finished.]'
const NOT_RUN = 'Not run: the turn was stopped before this call finished.'
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

/** The start and the end of a long text, with a note of how much was left out between them. */
function clipText(text: string, limit: number): string {
  if (text.length <= limit) return text
  const tail = Math.floor(limit * 0.2)
  const head = limit - tail
  return `${text.slice(0, head)}\n[${(text.length - limit).toLocaleString('en-US')} characters not kept]\n${tail > 0 ? text.slice(-tail) : ''}`
}

function clipValue(value: JSONValue, limit: number, depth = 0): JSONValue {
  if (typeof value === 'string') return clipText(value, limit)
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) return '[nested data not kept]'
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => clipValue(item, limit, depth + 1))
  return Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, item]) => [key, clipValue(item, limit, depth + 1)]))
}

function keptText(part: TextPart, limit: number): TextPart | undefined {
  const text = clipText(part.text, limit)
  return text.trim() ? { type: 'text', text } : undefined
}

function keptResult(part: ToolResultPart, clip: Clip): ToolResultPart {
  const pieces: string[] = []
  let images = 0
  for (const piece of part.content) {
    if (piece.type === 'text') pieces.push(piece.text)
    else images++
  }
  const whole = pieces.join('\n')
  const text = clip.result > 0
    ? clipText(whole, clip.result)
    : `[Result not kept: ${whole.length.toLocaleString('en-US')} characters.${part.isError ? ' It was an error.' : ''}]`
  return {
    type: 'tool_result',
    toolUseId: part.toolUseId,
    content: [{ type: 'text', text: images > 0 ? `${text}\n[${images} image${images === 1 ? '' : 's'} not kept]` : text }],
    ...(part.isError ? { isError: true } : {})
  }
}

function keptMessage(message: AIMessage, clip: Clip): AIMessage | undefined {
  const content: MessageContentPart[] = []
  for (const part of message.content) {
    if (part.type === 'text') {
      // Calls the harness recovered from text are replayed as calls, so their markup is not kept twice.
      const text = message.role === 'assistant' ? stripXmlToolMarkup(part.text) : part.text
      const kept = keptText({ ...part, text }, clip.text)
      if (kept) content.push({ type: 'text', text: kept.text })
    } else if (part.type === 'tool_use' && message.role === 'assistant') {
      content.push({ type: 'tool_use', id: part.id, name: part.name, input: clipValue(part.input, clip.input) })
    } else if (part.type === 'tool_result' && message.role === 'tool') {
      content.push(keptResult(part, clip))
    }
  }
  return content.length > 0 ? { role: message.role, content } : undefined
}

/**
 * Every call gets exactly one result, directly after the message that made it, and nothing else carries a
 * result: providers refuse a history that breaks that. A call the turn never finished is answered "not run".
 */
function paired(messages: readonly AIMessage[]): AIMessage[] {
  const out: AIMessage[] = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (message.role === 'tool') continue
    out.push(message)
    if (message.role !== 'assistant') continue
    const ids = message.content.flatMap((part) => (part.type === 'tool_use' ? [part.id] : []))
    if (ids.length === 0) continue
    const next = messages[index + 1]
    const answers = new Map<string, ToolResultPart>()
    if (next?.role === 'tool') {
      for (const part of next.content) if (part.type === 'tool_result') answers.set(part.toolUseId, part)
      index++
    }
    out.push({
      role: 'tool',
      content: ids.map((id) => answers.get(id) ?? { type: 'tool_result', toolUseId: id, isError: true, content: [{ type: 'text', text: NOT_RUN }] })
    })
  }
  const last = out[out.length - 1]
  if (last?.role === 'tool') out.push({ role: 'assistant', content: [{ type: 'text', text: STOPPED_NOTE }] })
  return out
}

const hasCalls = (messages: readonly AIMessage[]): boolean => messages.some((message) => message.content.some((part) => part.type === 'tool_use'))

/**
 * The messages of one turn in the form kept on record: reasoning dropped (it belongs to the request that made
 * it), long text and output shortened, calls and results paired. Undefined when the turn used no tool, since a
 * stored answer already says everything such a turn did.
 */
export function recordableTurn(messages: readonly AIMessage[]): AIMessage[] | undefined {
  if (!hasCalls(messages)) return undefined
  for (const clip of CLIPS) {
    const kept = paired(messages.flatMap((message) => keptMessage(message, clip) ?? []))
    if (JSON.stringify(kept).length <= MAX_TURN_CHARACTERS) return kept
  }
  return undefined
}

interface TurnRecord { id: string; messages: AIMessage[] }
interface TaskFile { version: 1; turns: TurnRecord[] }

export interface TurnLogOptions {
  onError?: (error: unknown) => void
}

/** One small file per task under the data folder; read when a turn starts, written when one ends. */
export class TurnLogStore {
  private readonly cache = new Map<string, TurnRecord[]>()

  constructor(
    private readonly dir: string,
    private readonly options: TurnLogOptions = {}
  ) {}

  private file(conversationId: string): string | undefined {
    return SAFE_ID.test(conversationId) ? join(this.dir, `${conversationId}.json`) : undefined
  }

  private read(conversationId: string): TurnRecord[] {
    const cached = this.cache.get(conversationId)
    if (cached) return cached
    const file = this.file(conversationId)
    let turns: TurnRecord[] = []
    if (file && existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<TaskFile>
        if (parsed.version === 1 && Array.isArray(parsed.turns)) {
          turns = parsed.turns.filter((turn): turn is TurnRecord =>
            !!turn && typeof turn.id === 'string' && Array.isArray(turn.messages) && turn.messages.length > 0)
        }
      } catch (error) {
        // A damaged file only costs the tool history of earlier turns; the transcript itself is elsewhere.
        this.options.onError?.(error)
      }
    }
    this.cache.set(conversationId, turns)
    return turns
  }

  /** The recorded turns of a task, by the id of the user message each one answered. */
  load(conversationId: string): ReadonlyMap<string, AIMessage[]> {
    return new Map(this.read(conversationId).map((turn) => [turn.id, turn.messages]))
  }

  /** Record what the model did while answering one message. A turn that used no tool is not recorded. */
  save(conversationId: string, messageId: string, messages: readonly AIMessage[]): void {
    const file = this.file(conversationId)
    const kept = recordableTurn(messages)
    if (!file || !kept || typeof messageId !== 'string' || !messageId) return
    const turns = this.read(conversationId).filter((turn) => turn.id !== messageId)
    turns.push({ id: messageId, messages: kept })
    while (turns.length > MAX_TURNS_PER_TASK) turns.shift()
    let body = JSON.stringify({ version: 1, turns } satisfies TaskFile)
    while (Buffer.byteLength(body) > MAX_FILE_BYTES && turns.length > 1) {
      turns.shift()
      body = JSON.stringify({ version: 1, turns } satisfies TaskFile)
    }
    try {
      mkdirSync(this.dir, { recursive: true })
      // Replace atomically: a crash while writing must not leave half a file behind.
      const temp = `${file}.${process.pid}.tmp`
      writeFileSync(temp, body, { mode: 0o600 })
      renameSync(temp, file)
      this.cache.set(conversationId, turns)
    } catch (error) {
      this.options.onError?.(error)
    }
  }

  deleteConversation(conversationId: string): void {
    this.cache.delete(conversationId)
    const file = this.file(conversationId)
    if (file) rmSync(file, { force: true })
  }
}
