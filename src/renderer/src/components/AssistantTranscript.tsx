import { useEffect, useRef } from 'react'
import { ChevronRight } from 'lucide-react'
import { messageDisplayBlocks } from '../../../shared/messageTranscript'
import type { TodoItem } from '../../../shared/ipc'
import type { LiveMessage } from '../state/store'
import type { HarnessState } from '../status/StatusIndicator'
import { CubexThinking } from '../theme/StateIcons'
import { useSmoothText } from '../lib/useSmoothText'
import { useElapsed } from '../lib/useElapsed'
import { formatSeconds } from '../lib/format'
import { groupTranscript, type Segment } from '../lib/transcriptGroups'
import { useStore } from '../state/store'
import { Markdown } from './Markdown'
import { ToolCard } from './ToolCard'
import { EditGroup, ExploreGroup, WebGroup } from './WorkRows'
import { TodoPlan } from './TodoPlan'
import './transcript.css'

interface Props {
  message: LiveMessage
  status: HarnessState
  waitingTool?: string
  pendingPlan: boolean
  pendingQuestion: boolean
  /** The newest assistant message owns the model's checklist. */
  showTodos?: boolean
}

/** The live reasoning disclosure replaces the pre-response Thinking row. */
export function hasActiveReasoning(message: LiveMessage, status: HarnessState): boolean {
  if (!message.streaming || (status !== 'thinking' && status !== 'planning')) return false
  const blocks = messageDisplayBlocks(message).filter((block) => block.type !== 'tool' || block.tool.name !== 'todo_write')
  return blocks.at(-1)?.type === 'reasoning' && (
    message.reasoningStart !== undefined || (!message.blocks?.length && !message.text)
  )
}

/** A visible running tool already owns the active indicator for this phase. */
export function hasActiveTool(message: LiveMessage, status: HarnessState): boolean {
  if (!message.streaming || !['running_tool', 'editing', 'removing', 'planning'].includes(status)) return false
  return messageDisplayBlocks(message).some((block) => block.type === 'tool' && block.tool.name !== 'todo_write' && block.tool.phase === 'running')
}

/** Reasoning text arrives in bursts like the answer, so it is revealed at the same steady pace and kept in view. */
function ReasoningText({ text, live }: { text: string; live: boolean }): JSX.Element {
  const shown = useSmoothText(text, live)
  const ref = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (el && live && following.current) el.scrollTop = el.scrollHeight
  }, [shown, live])
  return (
    <div
      className="reasoning__body"
      ref={ref}
      onScroll={(event) => {
        const el = event.currentTarget
        following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
    >
      {shown}
    </div>
  )
}

function Reasoning({ segment, live, startedAt }: { segment: Extract<Segment, { kind: 'reasoning' }>; live: boolean; startedAt?: number }): JSX.Element {
  const elapsed = useElapsed(startedAt, live, 1000)
  const took = segment.durationMs === undefined ? undefined : formatSeconds(segment.durationMs)
  // Auto-open while the model is reasoning so its thinking is readable live; it folds
  // back to "Thought for Ns" once the turn moves on.
  return (
    <details open={live ? true : undefined} className={`reasoning transcript-block transcript-block--reasoning ${live ? 'is-live' : ''}`} data-transcript="reasoning">
      <summary>
        <CubexThinking size={14} className="reasoning__icon" active={live} />
        <span className={`reasoning__label ${live ? 'is-shimmer' : ''}`}>{live ? 'Thinking' : took ? `Thought for ${took}` : 'Thought'}</span>
        {live && startedAt !== undefined && <span className="reasoning__time">{formatSeconds(elapsed * 1000)}</span>}
        <ChevronRight size={13} className="reasoning__chev" aria-hidden="true" />
      </summary>
      <ReasoningText text={segment.text} live={live} />
    </details>
  )
}

/** Rows that do not own the checklist subscribe to this instead, so a checklist update leaves them alone. */
const NO_TODOS: TodoItem[] = []

/** One timeline for both the live turn and its saved display transcript. */
export function AssistantTranscript({ message, status, waitingTool, pendingPlan, pendingQuestion, showTodos = false }: Props): JSX.Element {
  const blocks = messageDisplayBlocks(message)
  const segments = groupTranscript(blocks)
  const todos = useStore((s) => (showTodos ? s.todos : NO_TODOS))
  const reasoningActive = hasActiveReasoning(message, status)

  // Only the last call with the asking tool's name is the one waiting; reads may run beside it.
  let waitingId: string | undefined
  for (const block of blocks) {
    if (block.type === 'tool' && block.tool.phase === 'running' && block.tool.name === waitingTool) waitingId = block.tool.id
  }
  const waiting = (tool: { id: string; name: string; phase: string }): boolean =>
    tool.phase === 'running' && (
      (tool.name === 'exit_plan_mode' && pendingPlan) || (tool.name === 'ask_user_question' && pendingQuestion) || tool.id === waitingId
    )

  const hasPlanMarker = segments.some((segment) => segment.kind === 'todos')
  const plan = showTodos && todos.length > 0
  return <div className="assistant-transcript">
    {plan && !hasPlanMarker && <div className="transcript-block"><TodoPlan todos={todos} /></div>}
    {segments.map((segment) => {
      switch (segment.kind) {
        case 'text': {
          const streamingText = message.streaming && status === 'streaming' && segment.last
          return <div className="prose transcript-block transcript-block--text" data-transcript="text" key={segment.key}>
            <Markdown text={segment.text} streaming={streamingText} />
          </div>
        }
        case 'reasoning':
          return <Reasoning key={segment.key} segment={segment} live={reasoningActive && segment.last} startedAt={message.reasoningStart} />
        case 'explore':
          return <div className="transcript-block transcript-block--tool" data-transcript="tool" key={segment.key}>
            <ExploreGroup tools={segment.tools} waitingId={waitingId} />
          </div>
        case 'web':
          return <div className="transcript-block transcript-block--tool" data-transcript="tool" key={segment.key}>
            <WebGroup tools={segment.tools} waitingId={waitingId} />
          </div>
        case 'edit':
          return <div className="transcript-block transcript-block--tool" data-transcript="tool" key={segment.key}>
            <EditGroup files={segment.files} tools={segment.tools} waitingId={waitingId} />
          </div>
        case 'command':
        case 'tool':
          return <div className="transcript-block transcript-block--tool" data-transcript="tool" key={segment.key}>
            <ToolCard tool={segment.tool} waitingForInput={waiting(segment.tool)} />
          </div>
        case 'todos':
          return plan ? <div className="transcript-block" key={segment.key}><TodoPlan todos={todos} /></div> : null
      }
    })}
  </div>
}
