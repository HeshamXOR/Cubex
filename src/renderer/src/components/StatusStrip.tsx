import { Cpu, Gauge, GitBranch, ShieldQuestion } from 'lucide-react'
import { effortOptionsFor, normalizeEffortFor } from '@core/providers'
import { useStore } from '../state/store'
import { AnimatedMark } from '../theme/AnimatedMark'
import { compactTokens } from '../lib/format'
import { useGitStatus } from '../lib/useGitStatus'
import { useSessionStates } from '../lib/useSessionStates'
import { UsageButton } from './UsageButton'
import './graphite.css'

/**
 * One 26px strip across the bottom of the window with the facts about the run: branch, model,
 * effort, context, spend and, on the right, whether the agent works or waits for the person.
 * It only displays; the controls stay in the composer.
 */
export function StatusStrip(): JSX.Element {
  const conversationId = useStore((s) => s.activeConversation?.id)
  const providers = useStore((s) => s.providers)
  const models = useStore((s) => s.models)
  const activeProviderId = useStore((s) => s.activeProviderId)
  const activeModel = useStore((s) => s.activeModel)
  const effort = useStore((s) => s.effort)
  const usage = useStore((s) => s.contextUsage)
  const git = useGitStatus(conversationId)
  const states = useSessionStates()

  const info = activeProviderId ? models[activeProviderId]?.find((model) => model.id === activeModel) : undefined
  const kind = providers.find((provider) => provider.id === activeProviderId)?.kind
  const effortModel = info ?? { id: activeModel ?? '' }
  const options = kind ? effortOptionsFor(kind, effortModel) : []
  const selected = kind ? normalizeEffortFor(kind, effort, effortModel) : undefined
  const effortLabel = options.find((option) => option.value === selected)?.label

  const windowSize = usage?.contextWindow ?? info?.contextWindow
  const finite = (value: number | undefined): number | undefined => (value !== undefined && Number.isFinite(value) ? value : undefined)
  const used = Math.max(0, finite(usage?.contextTokens) ?? finite(usage?.estimatedTokens) ?? 0)
  const known = windowSize !== undefined && Number.isFinite(windowSize) && windowSize > 0
  const percent = known ? Math.min(100, (used / windowSize) * 100) : 0

  const state = conversationId ? states[conversationId] ?? 'idle' : 'idle'
  const branch = git?.isRepo ? git.branch ?? (git.head ? `Detached at ${git.head}` : 'Detached') : undefined

  return (
    <footer className="strip" aria-label="Status">
      {branch && <span className="strip__item" title="Current branch"><GitBranch size={12} strokeWidth={1.75} aria-hidden="true" />{branch}</span>}
      {activeModel && <span className="strip__item" title="Model"><Cpu size={12} strokeWidth={1.75} aria-hidden="true" />{info?.displayName || activeModel}</span>}
      {effortLabel && <span className="strip__item" title="Effort"><Gauge size={12} strokeWidth={1.75} aria-hidden="true" />{effortLabel} effort</span>}
      {known ? (
        <span className="strip__item" title="Context in use">
          Context {compactTokens(used)} of {compactTokens(windowSize)}
          <span className="strip__meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-label="Context used" data-high={percent >= 80 ? '' : undefined}><i style={{ width: `${Math.max(percent, used > 0 ? 3 : 0)}%` }} /></span>
        </span>
      ) : used > 0 && (
        // The model's window is not known, so the amount in use stands alone, as it does in the composer.
        <span className="strip__item" title="Context in use">Context {compactTokens(used)}</span>
      )}
      <UsageButton variant="strip" />
      {state === 'waiting' && (
        <span className="strip__state strip__state--need" role="status"><ShieldQuestion size={13} strokeWidth={1.75} aria-hidden="true" />Waiting for you</span>
      )}
      {state === 'running' && (
        <span className="strip__state" role="status"><AnimatedMark size={13} state="working" />Working</span>
      )}
    </footer>
  )
}
