import { beforeEach, describe, expect, it } from 'vitest'
import { COMMENT_MAX_LENGTH, MAX_QUEUED_COMMENTS, loadQueued, useReviewComments, type QueuedComment } from './reviewComments'

const memory = new Map<string, string>()

beforeEach(() => {
  memory.clear()
  Object.assign(globalThis, {
    localStorage: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => { memory.set(key, value) },
      removeItem: (key: string) => { memory.delete(key) }
    }
  })
  useReviewComments.setState({ byConversation: {} })
})

const comment = (id: string, extra: Partial<QueuedComment> = {}): QueuedComment =>
  ({ id, path: 'src/a.ts', startLine: 4, endLine: 6, side: 'new', hunkId: 'a'.repeat(40), text: `Comment ${id}`, createdAt: 1, ...extra })

const queued = (conversationId = 'c1'): readonly QueuedComment[] => useReviewComments.getState().byConversation[conversationId] ?? []

describe('the review comment queue', () => {
  it('keeps comments in the order they were written, per conversation', () => {
    const { add } = useReviewComments.getState()
    add('c1', comment('a'))
    add('c1', comment('b'))
    add('c2', comment('c'))
    expect(queued('c1').map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(queued('c2').map((entry) => entry.id)).toEqual(['c'])
  })

  it('edits and removes one comment without touching the others', () => {
    const { add, edit, remove } = useReviewComments.getState()
    add('c1', comment('a'))
    add('c1', comment('b'))
    add('c1', comment('c'))
    edit('c1', 'b', '  Reworded.  ')
    remove('c1', ['a', 'c'])
    expect(queued().map((entry) => [entry.id, entry.text])).toEqual([['b', 'Reworded.']])
  })

  it('refuses an empty comment, and an edit that would empty one', () => {
    const { add, edit } = useReviewComments.getState()
    expect(add('c1', comment('a', { text: '   ' }))).toBe(false)
    add('c1', comment('b'))
    edit('c1', 'b', '  ')
    expect(queued()[0]!.text).toBe('Comment b')
  })

  it('holds no more than one message can carry, and cuts a comment that is too long', () => {
    const { add } = useReviewComments.getState()
    for (let index = 0; index < MAX_QUEUED_COMMENTS; index++) expect(add('c1', comment(`k${index}`))).toBe(true)
    expect(add('c1', comment('one-more'))).toBe(false)
    expect(queued()).toHaveLength(MAX_QUEUED_COMMENTS)
    useReviewComments.setState({ byConversation: {} })
    add('c2', comment('long', { text: 'x'.repeat(COMMENT_MAX_LENGTH + 50) }))
    expect(queued('c2')[0]!.text).toHaveLength(COMMENT_MAX_LENGTH)
  })

  it('survives a restart, and a conversation with nothing queued leaves nothing behind', () => {
    const { add, remove, hydrate } = useReviewComments.getState()
    add('c1', comment('a', { excerpt: 'return withBackoff(' }))
    useReviewComments.setState({ byConversation: {} })
    hydrate('c1')
    expect(queued()).toEqual([comment('a', { excerpt: 'return withBackoff(' })])
    remove('c1', ['a'])
    expect(memory.has('cubex.reviewComments.c1')).toBe(false)
  })
})

describe('loadQueued', () => {
  it('drops anything that is not a well-formed comment instead of failing', () => {
    memory.set('cubex.reviewComments.c1', JSON.stringify([comment('ok'), { id: 'no-text' }, null, 5, comment('bad-side', { side: 'both' as never }), comment('bad-line', { startLine: 1.5 })]))
    expect(loadQueued('c1').map((entry) => entry.id)).toEqual(['ok'])
    memory.set('cubex.reviewComments.c2', 'not json')
    expect(loadQueued('c2')).toEqual([])
    memory.set('cubex.reviewComments.c3', '{"id":"a"}')
    expect(loadQueued('c3')).toEqual([])
  })
})
