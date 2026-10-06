import type { MessageContentPart } from '@core/types'
import type { HarnessState } from '../status/StatusIndicator'

/** A message typed while a turn was running, waiting for its turn. Attachments travel with it. */
export interface QueuedMessage {
  id: string
  text: string
  attachments: MessageContentPart[]
  queuedAt: number
}

/** More than this is a to-do list, not a next step, and every row costs the composer height. */
export const QUEUE_LIMIT = 20

/** How the most recent turn ended, once none is running. */
export type TurnEnd = 'completed' | 'failed' | 'stopped'

export interface QueueConditions {
  /** A turn is starting or running. */
  running: boolean
  /** Older messages are being summarized; nothing may start meanwhile. */
  compacting: boolean
  /** The turn is paused on a permission, a question or a plan. */
  needsAnswer: boolean
  /** A usable model is selected. */
  modelReady: boolean
  /** How the last turn ended; undefined when none ran in this session. */
  lastEnd: TurnEnd | undefined
  /** The task is the one on screen: sending goes through the visible conversation. */
  viewing: boolean
}

export type QueueGate =
  /** Send the first message now. */
  | { action: 'send' }
  /** It will send by itself once this passes. */
  | { action: 'wait'; reason: 'turn' | 'compacting' | 'elsewhere' }
  /** It will not send until the person acts. */
  | { action: 'hold'; reason: 'needs_answer' | 'failed' | 'stopped' | 'no_model' }

/** Whether the queue sends, waits for something that will pass, or holds for the person. */
export function queueGate(conditions: QueueConditions): QueueGate {
  if (conditions.needsAnswer) return { action: 'hold', reason: 'needs_answer' }
  if (conditions.compacting) return { action: 'wait', reason: 'compacting' }
  if (conditions.running) return { action: 'wait', reason: 'turn' }
  // Only a turn that finished normally lets the next message go: a failed or stopped one may need a different instruction.
  if (conditions.lastEnd === 'failed') return { action: 'hold', reason: 'failed' }
  if (conditions.lastEnd === 'stopped') return { action: 'hold', reason: 'stopped' }
  if (!conditions.modelReady) return { action: 'hold', reason: 'no_model' }
  if (!conditions.viewing) return { action: 'wait', reason: 'elsewhere' }
  return { action: 'send' }
}

/** The end of a turn, as the store's status records it. */
export function turnEndFor(status: HarnessState): TurnEnd | undefined {
  if (status === 'done') return 'completed'
  if (status === 'error') return 'failed'
  if (status === 'cancelled') return 'stopped'
  return undefined
}

/** One plain sentence on what the queue is waiting for. */
export function describeGate(gate: QueueGate): string {
  if (gate.action === 'send') return 'Sending the next message.'
  if (gate.action === 'wait') {
    if (gate.reason === 'turn') return 'Sends when this turn finishes.'
    if (gate.reason === 'compacting') return 'Sends when the summary is written.'
    return 'Sends when you open this task.'
  }
  if (gate.reason === 'needs_answer') return 'Waiting for your answer above. The queue sends after this turn.'
  if (gate.reason === 'failed') return 'The last turn failed, so the queue is on hold. Use Send now to continue.'
  if (gate.reason === 'stopped') return 'You stopped the last turn, so the queue is on hold. Use Send now to continue.'
  return 'Choose a model to send queued messages.'
}

export function enqueue(queue: readonly QueuedMessage[], item: QueuedMessage): { queue: QueuedMessage[]; accepted: boolean } {
  if (queue.length >= QUEUE_LIMIT || (!item.text.trim() && item.attachments.length === 0)) return { queue: [...queue], accepted: false }
  return { queue: [...queue, item], accepted: true }
}

/** Remove one message and hand it back: for Edit, Remove and Send now. */
export function take(queue: readonly QueuedMessage[], id: string): { item: QueuedMessage | undefined; queue: QueuedMessage[] } {
  const item = queue.find((entry) => entry.id === id)
  return { item, queue: queue.filter((entry) => entry.id !== id) }
}

/** Put a message back where it was taken from: the front, because it was next in line. */
export function putBack(queue: readonly QueuedMessage[], item: QueuedMessage): QueuedMessage[] {
  return queue.some((entry) => entry.id === item.id) ? [...queue] : [item, ...queue]
}

/** Keep only the queues of tasks that still exist. */
export function pruneQueues(queues: Readonly<Record<string, QueuedMessage[]>>, known: ReadonlySet<string>): Record<string, QueuedMessage[]> {
  return Object.fromEntries(Object.entries(queues).filter(([id, queue]) => known.has(id) && queue.length > 0))
}
