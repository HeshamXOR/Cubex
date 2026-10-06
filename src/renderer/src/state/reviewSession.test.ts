import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReviewHunk } from '../../../shared/ipc'

vi.mock('../lib/api', () => ({ api: {} }))
import { lastUserMessageId, staleKey, useReviewSession, type CommentDraft, type UndoneHunk } from './reviewSession'

const hunk = (id: string): ReviewHunk =>
  ({ id, header: '@@ -1,1 +1,1 @@', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'], state: 'pending' })
const undone = (revertId: string, id: string, path = 'src/a.ts'): UndoneHunk => ({ revertId, path, hunk: hunk(id), afterHash: 'f'.repeat(64) })
const session = (conversationId = 'c1') => useReviewSession.getState().sessions[conversationId]

beforeEach(() => useReviewSession.setState({ sessions: {} }))

describe('hunks undone in a conversation', () => {
  it('are kept in the order they were undone, per conversation', () => {
    const { recordUndone } = useReviewSession.getState()
    recordUndone('c1', 'm1', [undone('r1', 'h1')])
    recordUndone('c1', 'm1', [undone('r2', 'h2')])
    recordUndone('c2', 'm9', [undone('r3', 'h3')])
    expect(session()!.undone.map((entry) => entry.hunk.id)).toEqual(['h1', 'h2'])
    expect(session('c2')!.undone.map((entry) => entry.hunk.id)).toEqual(['h3'])
  })

  it('are dropped when the person has sent a message since, because they can no longer be brought back', () => {
    const { recordUndone } = useReviewSession.getState()
    recordUndone('c1', 'm1', [undone('r1', 'h1')])
    recordUndone('c1', 'm2', [undone('r2', 'h2')])
    expect(session()!.undone.map((entry) => entry.revertId)).toEqual(['r2'])
    expect(session()!.userMessageId).toBe('m2')
  })

  it('are forgotten one undo at a time', () => {
    const { recordUndone, forgetUndone } = useReviewSession.getState()
    recordUndone('c1', 'm1', [undone('r1', 'h1'), undone('r1', 'h2'), undone('r2', 'h3')])
    forgetUndone('c1', 'r1')
    expect(session()!.undone.map((entry) => entry.hunk.id)).toEqual(['h3'])
  })

  it('never hold more than a big review needs', () => {
    const { recordUndone } = useReviewSession.getState()
    recordUndone('c1', 'm1', Array.from({ length: 80 }, (_, index) => undone('r1', `h${index}`)))
    expect(session()!.undone).toHaveLength(60)
    expect(session()!.undone.at(-1)!.hunk.id).toBe('h79')
  })
})

describe('hunks that could not be undone', () => {
  it('are marked with why, and the marks of a file go when its hunks are read again', () => {
    const { markStale, clearStale } = useReviewSession.getState()
    markStale('c1', 'src/a.ts', 'a'.repeat(64), [{ hunkId: 'h1', reason: 'drift' }, { hunkId: 'h2', reason: 'context_mismatch' }])
    markStale('c1', 'src/b.ts', null, [{ hunkId: 'h1', reason: 'drift' }])
    expect(session()!.stale[staleKey('src/a.ts', 'h2')]).toEqual({ reason: 'context_mismatch', headHash: 'a'.repeat(64) })
    clearStale('c1', 'src/a.ts')
    expect(Object.keys(session()!.stale)).toEqual([staleKey('src/b.ts', 'h1')])
  })

  it('keep a file apart from another whose path starts the same way', () => {
    const { markStale, clearStale } = useReviewSession.getState()
    markStale('c1', 'src/a.ts', null, [{ hunkId: 'h1', reason: 'drift' }])
    markStale('c1', 'src/a.tsx', null, [{ hunkId: 'h1', reason: 'drift' }])
    clearStale('c1', 'src/a.ts')
    expect(Object.keys(session()!.stale)).toEqual([staleKey('src/a.tsx', 'h1')])
  })
})

describe('comments being written', () => {
  const draft = (id: string, text = ''): CommentDraft => ({ id, path: 'src/a.ts', hunkId: 'h1', startLine: 4, endLine: 6, side: 'new', text })

  it('keep the words typed so far until the editor is closed', () => {
    const { openDraft, setDraftText, closeDraft } = useReviewSession.getState()
    openDraft('c1', draft('d1'))
    setDraftText('c1', 'd1', 'Use a named constant')
    expect(session()!.drafts).toEqual([draft('d1', 'Use a named constant')])
    closeDraft('c1', 'd1')
    expect(session()!.drafts).toEqual([])
  })

  it('open once per place, so a second click finds the editor that is already there', () => {
    const { openDraft, setDraftText } = useReviewSession.getState()
    openDraft('c1', draft('d1'))
    setDraftText('c1', 'd1', 'half a thought')
    openDraft('c1', draft('d1'))
    openDraft('c1', draft('d2'))
    expect(session()!.drafts.map((open) => [open.id, open.text])).toEqual([['d1', 'half a thought'], ['d2', '']])
  })
})

describe('lastUserMessageId', () => {
  it('is the newest message the person sent', () => {
    expect(lastUserMessageId([{ id: 'u1', role: 'user' }, { id: 'a1', role: 'assistant' }, { id: 'u2', role: 'user' }, { id: 'a2', role: 'assistant' }])).toBe('u2')
    expect(lastUserMessageId([{ id: 'a1', role: 'assistant' }])).toBeUndefined()
    expect(lastUserMessageId([])).toBeUndefined()
  })
})
