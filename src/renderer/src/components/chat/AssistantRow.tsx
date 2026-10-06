import { memo } from 'react'
import { Check, Copy, RefreshCw, TriangleAlert } from 'lucide-react'
import type { NormalizedAIErrorData } from '@core/types'
import { useStore, type LiveMessage } from '../../state/store'
import { presentError } from '../../lib/errorPresentation'
import { useBusy } from '../../lib/useBusy'
import { AssistantTranscript, hasActiveReasoning, hasActiveTool } from '../AssistantTranscript'
import { ActivityRow } from '../../status/ActivityRow'
import type { HarnessState } from '../../status/StatusIndicator'

/**
 * A failed turn. The category becomes a plain headline and a line of guidance;
 * the provider's own words stay available underneath for the real detail.
 */
function TurnError({ error, onRetry }: { error: NormalizedAIErrorData; onRetry: () => void }): JSX.Element {
  const { title, guidance, action } = presentError(error.category)
  const busy = useBusy()
  const compactActive = useStore((s) => s.compactActive)
  const setView = useStore((s) => s.setView)
  const detail = error.message?.trim()
  return (
    <div className="turn-error" role="alert">
      <TriangleAlert className="turn-error__icon" size={15} strokeWidth={2} aria-hidden="true" />
      <div className="turn-error__body">
        <p className="turn-error__title">{title}</p>
        <p className="turn-error__guidance">{guidance}</p>
        {detail && <p className="turn-error__detail">{detail}</p>}
        <div className="turn-error__actions">
          {action === 'retry' && (
            <button className="btn sm" disabled={busy} onClick={onRetry}><RefreshCw size={13} />Retry</button>
          )}
          {action === 'compact' && (
            <button className="btn sm" disabled={busy} onClick={() => void compactActive()}>Summarize earlier messages</button>
          )}
          {action === 'providers' && (
            <button className="btn sm" onClick={() => setView('providers')}>Open Providers</button>
          )}
          {action !== 'retry' && action !== 'none' && (
            <button className="btn sm ghost" disabled={busy} onClick={onRetry}><RefreshCw size={13} />Retry</button>
          )}
        </div>
      </div>
    </div>
  )
}

function AssistantTools({ message, copied, onCopy, onRegenerate }: {
  message: LiveMessage; copied: boolean; onCopy: (id: string, text: string) => void; onRegenerate: () => void
}): JSX.Element {
  const busy = useBusy()
  return (
    <div className="msg-tools">
      <button className="msg-tool" onClick={() => onCopy(message.id, message.text)}>
        {copied ? <><Check size={12.5} />Copied</> : <><Copy size={12.5} />Copy</>}
      </button>
      <button className="msg-tool" disabled={busy} onClick={onRegenerate}><RefreshCw size={12.5} />Regenerate</button>
    </div>
  )
}

interface AssistantRowProps {
  message: LiveMessage
  /** Above the context divider: still shown, but the model no longer sees it. */
  outside: boolean
  /** Rows other than the one being written get 'idle' and `undefined` live details, so they stay untouched while a turn runs. */
  status: HarnessState
  waitingTool?: string
  pendingPlan: boolean
  pendingQuestion: boolean
  showTodos: boolean
  genStartedAt?: number
  statusDetail?: string
  copied: boolean
  onCopy: (id: string, text: string) => void
  onRegenerate: () => void
}

/**
 * One assistant turn in the thread. Memoized: while a later turn streams, every
 * finished row receives identical props and is skipped, so the cost of a delta
 * does not grow with the length of the conversation.
 */
export const AssistantRow = memo(function AssistantRow({
  message: m, outside, status, waitingTool, pendingPlan, pendingQuestion, showTodos, genStartedAt, statusDetail, copied, onCopy, onRegenerate
}: AssistantRowProps): JSX.Element {
  return (
    <div className={`a${outside ? ' is-outside' : ''}`} data-message="assistant">
      <AssistantTranscript
        message={m}
        status={status}
        waitingTool={waitingTool}
        pendingPlan={pendingPlan}
        pendingQuestion={pendingQuestion}
        showTodos={showTodos}
      />
      {/* The live phase stays visible after commentary and while tool arguments stream.
          A live reasoning or tool row owns its own motion, and streamed text is its own signal. */}
      {m.streaming && !m.error && status !== 'streaming' && status !== 'awaiting_input' && !hasActiveReasoning(m, status) && !hasActiveTool(m, status) && (
        <ActivityRow state={status} startedAt={genStartedAt}
          label={status === 'preparing_tool' ? statusDetail : undefined}
          detail={status === 'preparing_tool' ? undefined : statusDetail} iconSize={14} />
      )}
      {m.transcriptTruncated && <p className="context-history-note">Some older activity details were shortened for storage. The response text is preserved.</p>}

      {m.error ? (
        <TurnError error={m.error} onRetry={onRegenerate} />
      ) : !m.streaming && m.text ? (
        <AssistantTools message={m} copied={copied} onCopy={onCopy} onRegenerate={onRegenerate} />
      ) : null}
    </div>
  )
})
