import type { ChatEvent, CubexAPI, ReviewFile, ReviewHunk, SessionFileChange } from '../../../../shared/ipc'
import { formatReviewComments } from '../../../../shared/reviewComments'
import { unchangedBefore } from '../hunkReview'
import type { PreviewSeed } from './index'
import { CLIENT, CLIENT_TEST, headHashOf, seedFiles, type SeedFile } from './review/files'

/**
 * Sample data for hunk review in the Changes tab. `?seed=1&done=1&review=hunks&tab=changes` splits the three files of the
 * story into hunks, with some kept, one undone and one that cannot be undone. Keep, Undo, Bring it back and Send comments
 * answer after a short wait, and Send plays the turn that follows. `rv=` picks a different situation:
 * `fresh` starts with nothing kept, undone or refused; `empty` has no changes at all; `none` reads no hunks although files
 * changed; `error` fails the read; `slow` takes a while to answer it; `working` is mid-turn; `sendfail` refuses to send.
 */

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** One undo that can be taken back: a hunk revert (`file`, `hunks`) or the revert of whole files (`files`). */
type Revert =
  | { kind: 'hunks'; file: SeedFile; hunks: ReviewHunk[]; beforeVersion: number; after: string }
  | { kind: 'files'; files: SeedFile[]; order: string[] }

const headerOf = (hunk: ReviewHunk): string => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`

/** Put the hunks in order and give each the place it now has in the file, the way the main process reads it again. */
function renumber(file: SeedFile): void {
  file.hunks.sort((a, b) => a.oldStart - b.oldStart)
  let shift = 0
  for (const hunk of file.hunks) {
    hunk.newStart = hunk.oldStart + shift
    hunk.header = headerOf(hunk)
    shift += hunk.newLines - hunk.oldLines
  }
}

const countLines = (file: SeedFile, tag: '+' | '-'): number => file.hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line[0] === tag).length, 0)

/** The line diff the whole-file view reads, with a note where unchanged lines were left out. */
function serialize(file: SeedFile): string {
  const rows: string[] = []
  file.hunks.forEach((hunk, index) => {
    const gap = unchangedBefore(file.hunks[index - 1], hunk)
    if (gap > 0) rows.push(`@⋯ ${gap} unchanged ${gap === 1 ? 'line' : 'lines'}`)
    rows.push(...hunk.lines)
  })
  return rows.join('\n')
}

const emit = (event: ChatEvent): void => {
  ;(window as unknown as { __emit?: (e: ChatEvent) => void }).__emit?.(event)
}

export const seed: PreviewSeed = {
  state: (flags) => (flags.get('review') === 'hunks' && flags.get('rv') === 'working' ? { status: 'running_tool', statusDetail: 'Editing files' } : undefined),
  api: (flags) => {
    if (flags.get('review') !== 'hunks') return {}
    const variant = flags.get('rv') ?? ''
    const files = seedFiles()
    const order = files.map((file) => file.path)
    const accepted = new Set<string>()
    const reverts = new Map<string, Revert>()
    let versions = 0
    const find = (path: string): SeedFile | undefined => files.find((file) => file.path === path)

    // What a changed file does when undone: some answer, one is refused as if the file had changed underneath it, one is matched loosely.
    const client = find(CLIENT)!
    const test = find(CLIENT_TEST)!
    const refused = new Map<string, 'drift' | 'context_mismatch'>([[client.hunks[6]!.id, 'context_mismatch'], [test.hunks[1]!.id, 'drift']])
    const shifted = new Set([client.hunks[7]!.id])
    const kept = [client.hunks[0]!, client.hunks[3]!, test.hunks[0]!]
    const undone = client.hunks[10]!
    const staleHunk = client.hunks[6]!

    const revertHunks = (file: SeedFile, targets: ReviewHunk[]): { revertId: string; after: string | null } => {
      const revertId = crypto.randomUUID()
      const beforeVersion = file.version
      const ids = new Set(targets.map((hunk) => hunk.id))
      file.hunks = file.hunks.filter((hunk) => !ids.has(hunk.id))
      renumber(file)
      file.version = ++versions
      reverts.set(revertId, { kind: 'hunks', file, hunks: targets, beforeVersion, after: headHashOf(file) })
      if (!file.hunks.length) files.splice(files.indexOf(file), 1)
      return { revertId, after: file.hunks.length || file.status !== 'added' ? headHashOf(file) : null }
    }

    // The start of the story: some hunks kept, one already undone. Done by doing it, so the way back works.
    let started = variant === 'fresh'
    const start = async (conversationId: string): Promise<void> => {
      if (started) return
      started = true
      for (const hunk of kept) accepted.add(hunk.id)
      const { revertId, after } = revertHunks(client, [undone])
      const { useReviewSession, lastUserMessageId } = await import('../../state/reviewSession')
      const { useStore } = await import('../../state/store')
      const { liveMessages } = useStore.getState()
      useReviewSession.getState().recordUndone(conversationId, lastUserMessageId(liveMessages), [{ revertId, path: CLIENT, hunk: undone, afterHash: after }])
      useReviewSession.getState().markStale(conversationId, CLIENT, headHashOf(client), [{ hunkId: staleHunk.id, reason: 'context_mismatch' }])
    }

    const toReview = (file: SeedFile): ReviewFile => ({
      path: file.path,
      status: file.status,
      added: countLines(file, '+'),
      removed: countLines(file, '-'),
      headHash: headHashOf(file),
      hunks: file.hunks.map((hunk) => ({ ...hunk, state: accepted.has(hunk.id) ? 'accepted' : 'pending' })),
      updatedAt: file.updatedAt
    })
    const toChange = (file: SeedFile): SessionFileChange => ({
      path: file.path, status: file.status as SessionFileChange['status'], added: countLines(file, '+'), removed: countLines(file, '-'),
      diff: serialize(file), updatedAt: file.updatedAt
    })

    const api: Partial<CubexAPI> = {
      getSessionChanges: async (conversationId) => {
        await start(conversationId)
        await wait(100)
        return variant === 'empty' ? [] : files.map(toChange)
      },
      getReview: async (conversationId) => {
        await wait(variant === 'slow' ? 3500 : 120)
        if (variant === 'error') throw new Error('The review index could not be read: EBUSY, resource busy or locked, open \'C:\\Users\\dev\\AppData\\Roaming\\Cubex\\cubex-data\\sessions\\c1\\index.json\'.')
        if (variant === 'none' || variant === 'empty') return []
        await start(conversationId)
        return files.map(toReview)
      },
      markReviewed: async (_conversationId, items) => {
        await wait(150)
        for (const item of items) {
          const file = find(item.path)
          if (file && item.headHash === headHashOf(file)) for (const id of item.hunkIds) accepted.add(id)
        }
      },
      revertHunks: async (_conversationId, request) => {
        await wait(250)
        const file = find(request.path)
        if (!file) throw new Error(`File "${request.path}" was not changed in this task.`)
        const targets = file.hunks.filter((hunk) => request.hunkIds.includes(hunk.id))
        if (!targets.length) throw new Error('Requested hunks were not found.')
        const conflicts = targets.flatMap((hunk) => (refused.has(hunk.id) ? [{ hunkId: hunk.id, reason: refused.get(hunk.id)! }] : []))
        if (conflicts.length) return { applied: [], conflicts, newHeadHash: headHashOf(file) }
        const drift = request.expectHeadHash !== '' && request.expectHeadHash !== headHashOf(file)
        const loose = targets.some((hunk) => shifted.has(hunk.id))
        const { revertId, after } = revertHunks(file, targets)
        return {
          applied: targets.map((hunk) => hunk.id),
          conflicts: [],
          newHeadHash: after,
          revertId,
          ...(loose || drift ? { fuzzy: targets.map((hunk) => ({ hunkId: hunk.id, fuzz: loose ? 1 : 0, offset: loose ? 4 : 0, drift })) } : {})
        }
      },
      revertSessionChanges: async (_conversationId, paths) => {
        await wait(200)
        if (/[?&]revert=error\b/.test(location.search)) throw new Error('Cubex could not read its saved copy of src/upload/client.ts. Close any program that has the file open and try again.')
        const targets = files.filter((file) => !paths || paths.includes(file.path))
        const revertId = crypto.randomUUID()
        reverts.set(revertId, { kind: 'files', files: targets, order })
        for (const file of targets) files.splice(files.indexOf(file), 1)
        return { restored: targets.map((file) => file.path), skipped: [], ...(targets.length ? { revertId } : {}) }
      },
      undoRevert: async (_conversationId, revertId) => {
        await wait(200)
        const revert = reverts.get(revertId)
        if (!revert) throw new Error('That undo is no longer available.')
        if (revert.kind === 'files') {
          files.push(...revert.files)
          files.sort((a, b) => revert.order.indexOf(a.path) - revert.order.indexOf(b.path))
          reverts.delete(revertId)
          return { restored: revert.files.map((file) => file.path) }
        }
        if (headHashOf(revert.file) !== revert.after) throw new Error('The file has changed since it was undone, so it cannot be brought back.')
        if (!files.includes(revert.file)) {
          files.push(revert.file)
          files.sort((a, b) => order.indexOf(a.path) - order.indexOf(b.path))
        }
        revert.file.hunks.push(...revert.hunks)
        renumber(revert.file)
        revert.file.version = revert.beforeVersion
        reverts.delete(revertId)
        return { restored: [revert.file.path] }
      },
      sendReviewComments: async (conversationId, comments, options) => {
        await wait(300)
        if (variant === 'sendfail') throw new Error('Cubex could not start the turn: no model is set up for this task. Choose one in the composer and send again.')
        const text = formatReviewComments(comments.map((comment) => ({ comment, hunk: find(comment.path)?.hunks.find((hunk) => hunk.id === comment.hunkId) })))
        const stamp = Date.now()
        const messageId = `review-${stamp}`
        const streamId = options?.streamId ?? `review-stream-${stamp}`
        const base = { streamId, conversationId, parentMessageId: messageId }
        emit({ ...base, sequence: 1, kind: 'userMessage', messageId, text })
        const reply = `I will go through the ${comments.length === 1 ? 'comment' : `${comments.length} comments`} one at a time and change each place it names.`
        window.setTimeout(() => emit({ ...base, sequence: 2, kind: 'stream', event: { type: 'text_delta', text: reply } }), 500)
        window.setTimeout(() => emit({
          ...base, sequence: 3, kind: 'stream',
          event: { type: 'completed', response: { id: `reply-${stamp}`, provider: 'seed', model: 'seed-1', text: reply, content: [{ type: 'text', text: reply }], toolCalls: [], stopReason: 'stop', createdAt: stamp } }
        }), 4200)
        return { messageId, streamId, text }
      }
    }
    return api
  }
}
