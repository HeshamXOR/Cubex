import type { PermissionAsk } from '../../../shared/ipc'
import { DELEGATE_ROLE_LABEL, isDelegateRole, type DelegateActivity, type DelegateFile, type DelegateStep } from '../../../shared/peers'
import { formatSeconds, plural } from './format'

/**
 * What the thread and the permission card say about a task handed to another agent. Pure on purpose: the wording is
 * decided and tested here, and the components only draw it.
 */

// --- The card in the thread ---------------------------------------------------------------

export interface DelegateRowView {
  /** The role, how many files and how long: "Implement, 2 files, 2m 5s". */
  meta: string
  /** What the agent is doing now, while it works. */
  step?: string
  /** The word for an ending that is not a success. */
  ended?: 'Failed' | 'Cancelled'
}

export function delegateRow(activity: DelegateActivity): DelegateRowView {
  const parts = [
    DELEGATE_ROLE_LABEL[activity.role],
    activity.files.length > 0 ? plural(activity.files.length, 'file') : undefined,
    activity.seconds !== undefined ? formatSeconds(activity.seconds * 1000) : undefined
  ]
  const live = activity.status === 'working' || activity.status === 'waiting'
  const current = live ? [...activity.steps].reverse().find((step) => step.state === 'running') ?? activity.steps[activity.steps.length - 1] : undefined
  return {
    meta: parts.filter((part): part is string => !!part).join(', '),
    ...(current ? { step: current.title } : {}),
    ...(activity.status === 'failed' ? { ended: 'Failed' as const } : activity.status === 'cancelled' ? { ended: 'Cancelled' as const } : {})
  }
}

export const FILE_CHANGE_WORD: Record<DelegateFile['change'], string> = { edited: 'edited', created: 'created', deleted: 'deleted' }

export type StepView = 'done' | 'failed' | 'running' | 'stopped'

/** How a step is drawn. One still in progress when the task ended did not finish, so it is not drawn as working. */
export function stepView(activity: DelegateActivity, step: DelegateStep): StepView {
  if (step.state !== 'running') return step.state
  return activity.status === 'working' || activity.status === 'waiting' ? 'running' : 'stopped'
}

/** What a screen reader hears after the step's title. */
export const STEP_SPOKEN: Record<StepView, string> = { done: '', failed: ', failed', running: ', in progress', stopped: ', did not finish' }

/** Said once under the list of files when some of them were changed without Cubex being asked. */
export function untrackedNote(files: readonly DelegateFile[]): string | undefined {
  const count = files.filter((file) => !file.tracked).length
  if (count === 0) return undefined
  return `${count === 1 ? 'The file marked not kept was' : `The ${count} files marked not kept were`} changed without Cubex being asked, so it saved no copy and Rewind cannot undo ${count === 1 ? 'it' : 'them'}.`
}

/** The heading over the agent's words: a report when it finished, what happened when it did not. */
export function reportHeading(activity: DelegateActivity): string {
  return activity.status === 'done' ? 'Report' : 'What happened'
}

// --- The questions -------------------------------------------------------------------------

export interface DelegateAskView {
  heading: string
  /** A short line next to the heading: the file, or the kind of task. */
  target?: string
  command?: string
  /** Lines of a change: '+' added, '-' removed, ' ' unchanged. */
  preview?: Array<{ tag: '+' | '-' | ' '; text: string }>
  body?: string
  /** What the person can count on once they have answered, said under the question. */
  note?: string
}

const TASK = /^To (.+) \((implement|research|review|test)\):\n\n([\s\S]*)$/
const PREVIEW_LINES = 40

/** Diff lines as the card draws them. A gap marker ("@12 more lines") becomes a plain line. */
export function previewLines(detail: string): Array<{ tag: '+' | '-' | ' '; text: string }> {
  const lines = detail.split('\n').map((line): { tag: '+' | '-' | ' '; text: string } => {
    const tag = line[0]
    if (tag === '+' || tag === '-') return { tag, text: line.slice(1) }
    if (tag === '@') return { tag: ' ', text: `… ${line.slice(1)}` }
    return { tag: ' ', text: tag === ' ' ? line.slice(1) : line }
  })
  if (lines.length <= PREVIEW_LINES) return lines
  return [...lines.slice(0, PREVIEW_LINES), { tag: ' ', text: `… ${lines.length - PREVIEW_LINES} more lines` }]
}

/**
 * The question for a delegated task, in two kinds: whether to hand the task over (it carries the task as the agent
 * will read it), and what the agent asks to do while it works (a change, a command). Undefined for any other tool.
 */
export function delegateAsk(ask: PermissionAsk): DelegateAskView | undefined {
  if (ask.toolName !== 'delegate_task') return undefined
  const step = ask.delegate
  if (step) {
    const { agent, action, target, command } = step
    switch (action) {
      case 'edit':
        return { heading: `${agent} wants to edit this file?`, ...(target ? { target } : {}), ...(ask.detail ? { preview: previewLines(ask.detail) } : {}), note: 'Rewind can undo it.' }
      case 'delete':
        return { heading: `${agent} wants to delete this file?`, ...(target ? { target } : {}), note: 'Rewind can undo it.' }
      case 'move':
        return { heading: `${agent} wants to move this file?`, ...(target ? { target } : {}), note: 'Rewind can undo it.' }
      case 'run':
        return { heading: `${agent} wants to run this command?`, command: command ?? ask.detail ?? '', note: 'Rewind can\'t undo what a command changes.' }
      case 'fetch':
        return { heading: `${agent} wants to fetch this page?`, ...(target ? { target } : {}), ...(ask.detail ? { body: ask.detail } : {}) }
      default:
        return { heading: `${ask.title}?`, ...(ask.detail ? { body: ask.detail } : {}) }
    }
  }
  const match = TASK.exec(ask.detail ?? '')
  const role = match?.[2]
  if (!match || !role || !isDelegateRole(role)) return { heading: `Allow ${ask.title || 'this task'}?`, ...(ask.detail ? { body: ask.detail } : {}) }
  return { heading: `Hand this task to ${match[1]}?`, target: DELEGATE_ROLE_LABEL[role], body: match[3] ?? '' }
}

/** Who the question is about, for the line under it: "Codex runs in lumen-web with your permissions." */
export function delegateAgentOf(ask: PermissionAsk): string | undefined {
  if (ask.toolName !== 'delegate_task') return undefined
  if (ask.delegate) return ask.delegate.agent
  const match = TASK.exec(ask.detail ?? '')
  return match?.[1]
}
