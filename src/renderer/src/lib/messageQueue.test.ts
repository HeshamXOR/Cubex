import { describe, expect, it } from 'vitest'
import {
  QUEUE_LIMIT,
  describeGate,
  enqueue,
  pruneQueues,
  putBack,
  queueGate,
  take,
  turnEndFor,
  type QueueConditions,
  type QueuedMessage
} from './messageQueue'

const message = (id: string, text = id, attachments: QueuedMessage['attachments'] = []): QueuedMessage => ({ id, text, attachments, queuedAt: 1 })

/** A task that is idle after a normal turn, on screen, with a model chosen: the queue may send. */
const ready: QueueConditions = { running: false, compacting: false, needsAnswer: false, modelReady: true, lastEnd: 'completed', viewing: true }

describe('what the queue does next', () => {
  it('sends the first message once the turn finished normally', () => {
    expect(queueGate(ready)).toEqual({ action: 'send' })
    expect(queueGate({ ...ready, lastEnd: undefined })).toEqual({ action: 'send' })
  })

  it('waits while a turn is running and while older messages are being summarized', () => {
    expect(queueGate({ ...ready, running: true })).toEqual({ action: 'wait', reason: 'turn' })
    expect(queueGate({ ...ready, compacting: true })).toEqual({ action: 'wait', reason: 'compacting' })
  })

  it('holds for the person when the turn is waiting on an answer, even though it is still running', () => {
    expect(queueGate({ ...ready, running: true, needsAnswer: true })).toEqual({ action: 'hold', reason: 'needs_answer' })
  })

  it('holds after a failed or a stopped turn instead of pushing on', () => {
    expect(queueGate({ ...ready, lastEnd: 'failed' })).toEqual({ action: 'hold', reason: 'failed' })
    expect(queueGate({ ...ready, lastEnd: 'stopped' })).toEqual({ action: 'hold', reason: 'stopped' })
  })

  it('holds when no model is chosen, and waits when the task is not on screen', () => {
    expect(queueGate({ ...ready, modelReady: false })).toEqual({ action: 'hold', reason: 'no_model' })
    expect(queueGate({ ...ready, viewing: false })).toEqual({ action: 'wait', reason: 'elsewhere' })
  })

  it('lets a failure or a stop win over being in the background, so it is reported when the task opens', () => {
    expect(queueGate({ ...ready, viewing: false, lastEnd: 'failed' })).toEqual({ action: 'hold', reason: 'failed' })
  })

  it('reads the end of a turn from the status the store keeps', () => {
    expect(turnEndFor('done')).toBe('completed')
    expect(turnEndFor('error')).toBe('failed')
    expect(turnEndFor('cancelled')).toBe('stopped')
    for (const status of ['idle', 'thinking', 'working', 'streaming', 'awaiting_input'] as const) expect(turnEndFor(status)).toBeUndefined()
  })

  it('says what it is waiting for in a plain sentence, without a dash or a dot-joined list', () => {
    const gates = [
      queueGate({ ...ready, running: true }), queueGate({ ...ready, compacting: true }), queueGate({ ...ready, viewing: false }),
      queueGate({ ...ready, needsAnswer: true }), queueGate({ ...ready, lastEnd: 'failed' }), queueGate({ ...ready, lastEnd: 'stopped' }),
      queueGate({ ...ready, modelReady: false }), queueGate(ready)
    ]
    const sentences = gates.map(describeGate)
    expect(new Set(sentences).size).toBe(sentences.length)
    for (const sentence of sentences) expect(sentence).not.toMatch(/ — | · /)
    expect(describeGate({ action: 'hold', reason: 'stopped' })).toContain('stopped')
  })
})

describe('the queue itself', () => {
  it('adds messages at the back and keeps their order', () => {
    let queue: QueuedMessage[] = []
    for (const id of ['a', 'b', 'c']) queue = enqueue(queue, message(id)).queue
    expect(queue.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
  })

  it('does not change the queue it was given', () => {
    const queue = [message('a')]
    enqueue(queue, message('b'))
    take(queue, 'a')
    putBack(queue, message('z'))
    expect(queue.map((entry) => entry.id)).toEqual(['a'])
  })

  it('refuses an empty message but accepts one that is only an attachment', () => {
    expect(enqueue([], message('a', '   ')).accepted).toBe(false)
    const image = { type: 'image' as const, source: { kind: 'base64' as const, mediaType: 'image/png', data: 'AAAA' } }
    expect(enqueue([], message('a', '', [image])).accepted).toBe(true)
  })

  it('stops at the limit and says so rather than dropping the oldest', () => {
    let queue: QueuedMessage[] = []
    for (let index = 0; index < QUEUE_LIMIT; index++) queue = enqueue(queue, message(`m${index}`)).queue
    const over = enqueue(queue, message('one-too-many'))
    expect(over.accepted).toBe(false)
    expect(over.queue).toHaveLength(QUEUE_LIMIT)
    expect(over.queue[0]!.id).toBe('m0')
  })

  it('takes one message out, attachments intact, and leaves the rest in order', () => {
    const file = { type: 'file' as const, filename: 'notes.txt', source: { kind: 'base64' as const, mediaType: 'text/plain', data: 'bm90ZXM=' } }
    const queue = [message('a'), message('b', 'with a file', [file]), message('c')]
    const taken = take(queue, 'b')
    expect(taken.item?.attachments).toEqual([file])
    expect(taken.queue.map((entry) => entry.id)).toEqual(['a', 'c'])
    expect(take(queue, 'missing').item).toBeUndefined()
  })

  it('puts a message back at the front, once', () => {
    const queue = [message('b'), message('c')]
    expect(putBack(queue, message('a')).map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
    expect(putBack(queue, message('b')).map((entry) => entry.id)).toEqual(['b', 'c'])
  })

  it('drops the queues of tasks that no longer exist and the ones that emptied', () => {
    const queues = { kept: [message('a')], gone: [message('b')], empty: [] }
    expect(pruneQueues(queues, new Set(['kept', 'empty']))).toEqual({ kept: [message('a')] })
  })
})
