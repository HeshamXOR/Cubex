import type { MessageContentPart, Role } from './content'

/**
 * A single normalized message. Content is always an array of parts internally;
 * builder helpers (see `builders.ts`) let callers pass plain strings ergonomically.
 */
export interface AIMessage {
  role: Role
  content: MessageContentPart[]
  /** Optional participant name (used by some providers). */
  name?: string
}
