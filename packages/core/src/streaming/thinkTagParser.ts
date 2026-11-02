export type ThinkParserEvent =
  | { type: 'reasoning_delta'; text: string }
  | { type: 'text_delta'; text: string }

export interface ThinkTagParser {
  push(chunk: string): ThinkParserEvent[]
  flush(): ThinkParserEvent[]
}

const OPEN_TAG = '<think>'
const CLOSE_TAG = '</think>'

enum ParserState {
  START = 0,
  IN_THINK = 1,
  AFTER_THINK = 2,
  TEXT = 3
}

function emit(events: ThinkParserEvent[], type: 'reasoning_delta' | 'text_delta', text: string): void {
  if (!text) return
  const last = events[events.length - 1]
  if (last && last.type === type) {
    last.text += text
  } else {
    events.push({ type, text })
  }
}

/**
 * Stateful streaming parser that detects leading `<think>...</think>` reasoning tags
 * in stream content chunks and separates reasoning from visible text deltas.
 */
export function createThinkTagParser(): ThinkTagParser {
  let state: ParserState = ParserState.START
  let startBuffer = ''
  let closeBuffer = ''
  let pendingCr = false
  /** Everything read as reasoning, so a stream that ends inside the tag can still give the person an answer. */
  let collectedReasoning = ''
  let visibleEmitted = false

  function observe(events: ThinkParserEvent[]): ThinkParserEvent[] {
    for (const event of events) {
      if (event.type === 'reasoning_delta') collectedReasoning += event.text
      else if (event.text.trim()) visibleEmitted = true
    }
    return events
  }

  function processAfterThink(text: string, events: ThinkParserEvent[]): void {
    if (!text) return

    let i = 0
    if (pendingCr) {
      pendingCr = false
      state = ParserState.TEXT
      if (text[0] === '\n') {
        i = 1
      }
      if (i < text.length) {
        emit(events, 'text_delta', text.slice(i))
      }
      return
    }

    const first = text[0]!
    if (first === '\r') {
      if (text.length >= 2) {
        state = ParserState.TEXT
        i = text[1] === '\n' ? 2 : 1
        if (i < text.length) {
          emit(events, 'text_delta', text.slice(i))
        }
      } else {
        pendingCr = true
      }
      return
    }

    if (first === '\n' || first === ' ' || first === '\t') {
      state = ParserState.TEXT
      if (text.length > 1) {
        emit(events, 'text_delta', text.slice(1))
      }
      return
    }

    state = ParserState.TEXT
    emit(events, 'text_delta', text)
  }

  function processInThink(text: string, events: ThinkParserEvent[]): void {
    let currentReasoning = ''

    const flushReasoning = (): void => {
      if (currentReasoning) {
        emit(events, 'reasoning_delta', currentReasoning)
        currentReasoning = ''
      }
    }

    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!
      if (ch === CLOSE_TAG[closeBuffer.length]) {
        flushReasoning()
        closeBuffer += ch
        if (closeBuffer === CLOSE_TAG) {
          closeBuffer = ''
          state = ParserState.AFTER_THINK
          const remainder = text.slice(i + 1)
          if (remainder) {
            processAfterThink(remainder, events)
          }
          return
        }
      } else {
        if (ch === '<') {
          if (closeBuffer) {
            currentReasoning += closeBuffer
          }
          closeBuffer = '<'
        } else {
          currentReasoning += closeBuffer + ch
          closeBuffer = ''
        }
      }
    }

    flushReasoning()
  }

  const parser: ThinkTagParser = {
    push(chunk: string): ThinkParserEvent[] {
      if (!chunk) return []
      const events: ThinkParserEvent[] = []

      if (state === ParserState.TEXT) {
        emit(events, 'text_delta', chunk)
        return events
      }

      if (state === ParserState.AFTER_THINK) {
        processAfterThink(chunk, events)
        return events
      }

      if (state === ParserState.IN_THINK) {
        processInThink(chunk, events)
        return events
      }

      // ParserState.START
      startBuffer += chunk
      const openMatch = startBuffer.match(/^(\s*)<think>/)
      if (openMatch) {
        const consumedLen = openMatch[0].length
        const remainder = startBuffer.slice(consumedLen)
        startBuffer = ''
        state = ParserState.IN_THINK
        if (remainder) {
          processInThink(remainder, events)
        }
        return events
      }

      let wsIndex = 0
      while (wsIndex < startBuffer.length && /\s/.test(startBuffer[wsIndex]!)) {
        wsIndex++
      }

      if (wsIndex === startBuffer.length) {
        // Only whitespace so far; keep waiting to see if <think> follows
        return []
      }

      const tagPart = startBuffer.slice(wsIndex)
      if (OPEN_TAG.startsWith(tagPart)) {
        // Candidate prefix for <think>; keep buffering
        return []
      }

      // Not a <think> tag; transition to TEXT and flush startBuffer
      state = ParserState.TEXT
      const text = startBuffer
      startBuffer = ''
      emit(events, 'text_delta', text)
      return events
    },

    flush(): ThinkParserEvent[] {
      const events: ThinkParserEvent[] = []
      if (state === ParserState.START) {
        if (startBuffer) {
          emit(events, 'text_delta', startBuffer)
          startBuffer = ''
        }
      } else if (state === ParserState.IN_THINK) {
        if (closeBuffer) {
          emit(events, 'reasoning_delta', closeBuffer)
          closeBuffer = ''
        }
      } else if (state === ParserState.AFTER_THINK) {
        pendingCr = false
      }
      return events
    }
  }

  return {
    push: (chunk) => observe(parser.push(chunk)),
    flush: () => {
      const events = observe(parser.flush())
      // The stream ended inside an unclosed <think> and nothing visible came out: the reasoning is the only
      // answer there is, so it is also given as text rather than leaving the reply empty.
      if (state === ParserState.IN_THINK && !visibleEmitted && collectedReasoning.trim()) {
        emit(events, 'text_delta', collectedReasoning)
        visibleEmitted = true
      }
      return events
    }
  }
}
