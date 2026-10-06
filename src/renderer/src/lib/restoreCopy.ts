import type { RestoreAxes, RestorePreview, RestoreResult } from '../../../shared/ipc'
import { plural } from './format'

/** What the person can go back to from a message: both, the conversation, or the files. */
export type RestoreChoice = 'both' | 'conversation' | 'code'

export const CHOICES: readonly RestoreChoice[] = ['both', 'conversation', 'code']

export const CHOICE_AXES: Record<RestoreChoice, RestoreAxes> = {
  both: { code: true, conversation: true },
  conversation: { code: false, conversation: true },
  code: { code: true, conversation: false }
}

export const CHOICE_LABEL: Record<RestoreChoice, string> = {
  both: 'Restore code and conversation',
  conversation: 'Restore conversation only',
  code: 'Restore code only'
}

export function choiceOf(axes: RestoreAxes): RestoreChoice {
  return axes.code && axes.conversation ? 'both' : axes.code ? 'code' : 'conversation'
}

const NO_CHECKPOINT = 'File checkpoints are kept only while Cubex is running.'
const CHECK_FAILED = 'Could not check which files would change.'

export interface ChoiceInfo {
  /** One line on what choosing it does. */
  effect: string
  /** Why it cannot be chosen; the effect line then says why too, so the menu never shows a dead option unexplained. */
  disabled?: string
}

/** The leave-alone clause shared by the options that touch files. */
const leaves = (preview: RestorePreview): string => (preview.blocked.length ? `, leaves ${plural(preview.blocked.length, 'file')} you edited` : '')

/**
 * The line under each option in the Restore menu. `messages` counts the chosen message and everything after
 * it. `preview` is undefined until main has answered, and `checkFailed` says it never will.
 */
export function describeChoice(choice: RestoreChoice, preview: RestorePreview | undefined, messages: number, checkFailed = false): ChoiceInfo {
  const removes = `Removes ${plural(messages, 'message')}`
  if (choice === 'conversation') return { effect: `${removes}. Files stay as they are.` }
  if (checkFailed) return { effect: CHECK_FAILED, disabled: CHECK_FAILED }
  if (!preview) return { effect: choice === 'both' ? `${removes}. Checking files.` : 'Checking which files would change.' }
  if (!preview.checkpoint) return { effect: NO_CHECKPOINT, disabled: NO_CHECKPOINT }
  const files = preview.files.length
  if (files === 0 && preview.blocked.length === 0) {
    return choice === 'both'
      ? { effect: `${removes}. No file changes to put back.` }
      : { effect: 'No file changes to put back.', disabled: 'No file changes to put back.' }
  }
  const back = `puts back ${plural(files, 'file')}${leaves(preview)}`
  return { effect: choice === 'both' ? `${removes}, ${back}.` : `${back[0]!.toUpperCase()}${back.slice(1)}. Messages stay.` }
}

/** What a file does when it is put back, for the confirmation list. */
export function actionPhrase(action: RestorePreview['files'][number]['action']): string {
  return action === 'delete' ? 'removed, Cubex created it' : action === 'recreate' ? 'brought back, Cubex removed it' : 'put back as it was'
}

export function restoredTitle(axes: RestoreAxes): string {
  return axes.code && axes.conversation ? 'Restored code and conversation' : axes.code ? 'Restored code' : 'Restored conversation'
}

/** The sentence under the title once a restore is done. */
export function restoredSummary(result: RestoreResult, axes: RestoreAxes): string {
  const parts: string[] = []
  if (axes.code) parts.push(result.restored.length ? `${plural(result.restored.length, 'file')} put back` : 'No files needed putting back')
  if (result.conversation) parts.push(`${plural(result.conversation.removedMessages, 'message')} removed`)
  const sentence = parts.length === 2 ? `${parts[0]} and ${parts[1]}` : parts[0] ?? ''
  const tail = !axes.code ? ' Files were not changed.' : !axes.conversation ? ' The conversation was not changed.' : ''
  return `${sentence}.${tail}`
}

/** The sentence under the title when an undo is done. */
export function undoneSummary(files: number, messages: number): string {
  const things = [...(files ? [plural(files, 'file')] : []), ...(messages ? [plural(messages, 'message')] : [])]
  if (!things.length) return 'Nothing needed to change back.'
  const single = things.length === 1 && (files === 1 || messages === 1)
  return `${things.join(' and ')} ${single ? 'is' : 'are'} back.`
}

/** What the notice above the composer is built from. It is the store's notice with the parts that have words. */
export interface NoticeFacts {
  kind: 'restored' | 'undone' | 'failed' | 'undo-failed'
  axes: RestoreAxes
  result?: RestoreResult | undefined
  undone?: { files: number; messages: number } | undefined
  /** Why it failed. The first line is the sentence; later lines are file paths. */
  error?: string | undefined
  /** The restore put the message back in the composer. */
  composerHasMessage: boolean
}

export interface NoticeList {
  label: string
  items: { path: string; why?: string }[]
}

export interface NoticeText {
  /** Neutral when all went well, amber when files were left alone, red when something failed. */
  tone: 'ok' | 'warn' | 'error'
  title: string
  summary: string
  lists: NoticeList[]
}

/** The words of the notice after a restore, an undo, or a try that failed. */
export function describeNotice(facts: NoticeFacts): NoticeText {
  if (facts.kind === 'undone') return { tone: 'ok', title: 'Restore undone', summary: undoneSummary(facts.undone?.files ?? 0, facts.undone?.messages ?? 0), lists: [] }
  if (facts.kind === 'failed' || facts.kind === 'undo-failed') {
    const [sentence = '', ...paths] = (facts.error ?? '').split('\n').map((line) => line.trim()).filter(Boolean)
    const fallback = facts.kind === 'failed' ? 'Nothing was changed.' : 'Your files and messages are as the restore left them.'
    return {
      tone: 'error',
      title: facts.kind === 'failed' ? 'Could not restore' : 'Could not undo the restore',
      summary: sentence || fallback,
      lists: paths.length ? [{ label: 'Files', items: paths.map((path) => ({ path })) }] : []
    }
  }
  const result: RestoreResult = facts.result ?? { restored: [], skipped: [], failed: [] }
  const lists: NoticeList[] = [
    ...(result.skipped.length ? [{ label: 'Left as they are because they changed outside Cubex', items: result.skipped.map((file) => ({ path: file.path, why: file.reason })) }] : []),
    ...(result.failed.length ? [{ label: 'Could not be written', items: result.failed.map((file) => ({ path: file.path, why: file.reason })) }] : [])
  ]
  if (result.failed.length) {
    const done = result.restored.length ? `${plural(result.restored.length, 'file')} put back.` : 'No files were put back.'
    return { tone: 'error', title: 'Some files could not be put back', summary: `${done}${facts.axes.conversation ? ' The conversation was kept so you can try again.' : ''}`, lists }
  }
  return {
    tone: result.skipped.length ? 'warn' : 'ok',
    title: restoredTitle(facts.axes),
    summary: `${restoredSummary(result, facts.axes)}${facts.composerHasMessage ? ' Your message is back in the composer.' : ''}`,
    lists
  }
}
