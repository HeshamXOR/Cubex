import type { ToolActivity } from '../../../shared/ipc'
import { messageDisplayBlocks } from '../../../shared/messageTranscript'
import type { LiveMessage } from '../state/store'
import { exploreSummary, groupPhase, groupTranscript, toolKind, toolTarget } from './transcriptGroups'

export type RunStepState = 'done' | 'running' | 'waiting' | 'error'

export interface RunStep {
  key: string
  label: string
  state: RunStepState
}

export interface WaitingFacts {
  /** The tool the open permission request is about. */
  tool?: string
  plan?: boolean
  question?: boolean
}

function lastName(path: string): string {
  const clean = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return clean.slice(clean.lastIndexOf('/') + 1) || clean
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

function stateOf(phase: ToolActivity['phase'], waiting: boolean): RunStepState {
  if (phase === 'error') return 'error'
  if (phase === 'running' || phase === 'queued') return waiting ? 'waiting' : 'running'
  return 'done'
}

/**
 * The steps of the latest turn, in the order they happened: the tool rows of every assistant
 * message after the last user message, folded the way the transcript folds them.
 */
export function deriveRunSteps(messages: readonly LiveMessage[], waiting: WaitingFacts = {}): RunStep[] {
  let start = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === 'user') { start = index; break }
  }
  const steps: RunStep[] = []
  // Only the last running call of the asking tool is the one that waits.
  let waitingId: string | undefined
  const turn = messages.slice(start + 1).filter((message) => message.role === 'assistant')
  for (const message of turn) {
    for (const block of messageDisplayBlocks(message)) {
      if (block.type === 'tool' && block.tool.phase === 'running' && (
        block.tool.name === waiting.tool || (waiting.plan && block.tool.name === 'exit_plan_mode') || (waiting.question && block.tool.name === 'ask_user_question')
      )) waitingId = block.tool.id
    }
  }
  const waits = (tool: ToolActivity): boolean => tool.id === waitingId

  for (const message of turn) {
    for (const segment of groupTranscript(messageDisplayBlocks(message))) {
      switch (segment.kind) {
        case 'explore': {
          const summary = exploreSummary(segment.tools)
          const label = summary.files.length > 0 ? `Read ${plural(summary.files.length, 'file')}`
            : summary.searches > 0 ? `Searched ${plural(summary.searches, 'time')}` : `Listed ${plural(summary.folders, 'folder')}`
          steps.push({ key: segment.key, label, state: stateOf(groupPhase(segment.tools), segment.tools.some(waits)) })
          break
        }
        case 'edit':
          for (const file of segment.files) {
            const verb = file.status === 'added' ? 'Created' : file.status === 'deleted' ? 'Removed' : 'Edited'
            steps.push({ key: `${segment.key}:${file.path}`, label: `${verb} ${lastName(file.path)}`, state: stateOf(file.phase, file.ids.some((id) => id === waitingId)) })
          }
          break
        case 'web':
          steps.push({ key: segment.key, label: `Fetched ${plural(segment.tools.length, 'page')}`, state: stateOf(groupPhase(segment.tools), segment.tools.some(waits)) })
          break
        case 'command':
          steps.push({ key: segment.key, label: `Run ${toolTarget(segment.tool) || 'a command'}`, state: stateOf(segment.tool.phase, waits(segment.tool)) })
          break
        case 'tool': {
          const target = toolTarget(segment.tool)
          const kind = toolKind(segment.tool.name)
          steps.push({ key: segment.key, label: target && target !== kind ? `${kind} ${target}` : kind, state: stateOf(segment.tool.phase, waits(segment.tool)) })
          break
        }
        default:
          break
      }
    }
  }
  return steps
}
