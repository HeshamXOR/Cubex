/** One message to an agent and what it answered. */
export interface Exchange {
  message: string
  reply: string
}

/** A talk with one agent runs a handful of rounds: older ones are let go so a long chat does not grow what each message carries. */
export const MAX_EXCHANGES = 6
export const MAX_HISTORY_CHARS = 40_000
/** Either side of an exchange is kept this long, so the newest two always fit. */
const MAX_PIECE_CHARS = 10_000

function keep(text: string): string {
  return text.length <= MAX_PIECE_CHARS ? text : `${text.slice(0, MAX_PIECE_CHARS)}\n[shortened]`
}

function size(exchanges: readonly Exchange[]): number {
  return exchanges.reduce((sum, entry) => sum + entry.message.length + entry.reply.length, 0)
}

/**
 * What each task has said to each other agent, so a later message continues the talk. The programs answer one message
 * and exit, so the conversation lives here and is sent along each time. It is kept in memory only: it does not outlive
 * the app, and it is dropped with the task.
 */
export class PeerTranscripts {
  private readonly talks = new Map<string, Exchange[]>()

  private key(conversationId: string, peerId: string): string {
    return `${conversationId}\u0000${peerId}`
  }

  history(conversationId: string, peerId: string): readonly Exchange[] {
    return this.talks.get(this.key(conversationId, peerId)) ?? []
  }

  record(conversationId: string, peerId: string, exchange: Exchange): void {
    const key = this.key(conversationId, peerId)
    const next = [...(this.talks.get(key) ?? []), { message: keep(exchange.message), reply: keep(exchange.reply) }]
    while (next.length > MAX_EXCHANGES || (next.length > 1 && size(next) > MAX_HISTORY_CHARS)) next.shift()
    this.talks.set(key, next)
  }

  /** Start over with one agent in one task, for example after the person edited it. */
  forget(conversationId: string, peerId: string): void {
    this.talks.delete(this.key(conversationId, peerId))
  }

  forgetConversation(conversationId: string): void {
    const prefix = `${conversationId}\u0000`
    for (const key of [...this.talks.keys()]) if (key.startsWith(prefix)) this.talks.delete(key)
  }
}
