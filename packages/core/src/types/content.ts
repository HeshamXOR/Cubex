import type { JSONValue } from './common'

/**
 * Message content is modeled as an array of *parts* rather than assuming plain
 * text. Provider adapters translate these into the native wire format and drop /
 * reject parts a model cannot handle.
 */

export type Role = 'system' | 'developer' | 'user' | 'assistant' | 'tool'

/** How binary/remote content is referenced. */
export type ContentSource =
  | { kind: 'url'; url: string }
  | { kind: 'base64'; mediaType: string; data: string }
  | { kind: 'file_id'; id: string; mediaType?: string }

export interface TextPart {
  type: 'text'
  text: string
  /** Decoded upload provenance for the harness; adapters send only `text`. */
  attachment?: {
    kind: 'text_file'
    filename: string
    mediaType: string
    sizeBytes: number
  }
}

export interface ImagePart {
  type: 'image'
  source: ContentSource
  /** Optional provider hint (e.g. OpenAI "detail"). */
  detail?: 'auto' | 'low' | 'high'
}

export interface FilePart {
  type: 'file'
  source: ContentSource
  filename?: string
  mediaType?: string
}

export interface AudioPart {
  type: 'audio'
  source: ContentSource
  mediaType: string
}

export interface VideoPart {
  type: 'video'
  source: ContentSource
  mediaType: string
}

/** Emitted by the assistant when it wants to call a tool. */
export interface ToolUsePart {
  type: 'tool_use'
  id: string
  name: string
  input: JSONValue
}

/** Provided back to the model as the result of a tool call. */
export interface ToolResultPart {
  type: 'tool_result'
  toolUseId: string
  /** Result content — text and/or images are the broadly supported subset. */
  content: Array<TextPart | ImagePart>
  isError?: boolean
}

/** Provider-exposed reasoning/thinking text (kept distinct from normal text). */
export interface ReasoningPart {
  type: 'reasoning'
  text: string
  /** Provider integrity token (Anthropic thinking signature); replay verbatim. */
  signature?: string
  /** Opaque encrypted reasoning (Anthropic redacted_thinking `data`). */
  redacted?: string
}

export type MessageContentPart =
  | TextPart
  | ImagePart
  | FilePart
  | AudioPart
  | VideoPart
  | ToolUsePart
  | ToolResultPart
  | ReasoningPart

export type MessageContentPartType = MessageContentPart['type']
