import { Check, Cloud, FlaskConical, Pencil, Server, Trash2, TriangleAlert, X } from 'lucide-react'
import type { ProviderConfig } from '@core/types'
import { StateIcon, type HarnessState } from '../../status/StatusIndicator'
import type { ProviderNotice } from '../../state/providerChecks'
import {
  ACCESS_LABEL,
  accessMode,
  describeRefresh,
  describeResult,
  isAzure,
  isCustomRest,
  isMock,
  keyState,
  rowFacts,
  type ConnectionState
} from '../../lib/providerView'

const STATE: Record<ConnectionState, { label: string; glyph?: HarnessState }> = {
  testing: { label: 'Testing', glyph: 'working' },
  ok: { label: 'Connected', glyph: 'done' },
  failed: { label: 'Could not connect', glyph: 'error' },
  'needs-key': { label: 'Needs a key', glyph: 'awaiting_input' },
  disabled: { label: 'Off', glyph: 'cancelled' },
  untested: { label: 'Not tested' }
}

const KEY_FACT = { saved: 'Saved', missing: 'Missing', optional: 'Not set' } as const

/** Custom JSON endpoints and the offline demo have no model list to fetch. */
const hasModelList = (cfg: ProviderConfig): boolean => !isMock(cfg.kind) && !isCustomRest(cfg)

export interface ProviderRowProps {
  provider: ProviderConfig
  state: ConnectionState
  notice: ProviderNotice | undefined
  refreshing: boolean
  /** A save, removal or switch for this provider is under way. */
  busy: boolean
  /** Another form is open, so this row's actions wait. */
  locked: boolean
  confirmingRemove: boolean
  removing: boolean
  onTest: () => void
  onRefresh: () => void
  onEdit: (focus?: 'key') => void
  onToggle: () => void
  onAskRemove: () => void
  onCancelRemove: () => void
  onRemove: () => void
  onDismiss: () => void
}

export function ProviderRow(props: ProviderRowProps): JSX.Element {
  const { provider: p, state, notice, refreshing, busy, locked, confirmingRemove, removing } = props
  const mode = accessMode(p)
  const facts = rowFacts(p)
  const key = keyState(p)
  const azure = isAzure(p)
  const ModeIcon = mode === 'offline' ? FlaskConical : mode === 'local' ? Server : Cloud
  const nameId = `provider-${p.id}-name`
  const status = STATE[state]
  const testing = state === 'testing'
  const idle = busy || locked
  return (
    <article className="providers__row" aria-labelledby={nameId} data-state={state}>
      <ModeIcon className="providers__icon" size={16} aria-hidden="true" />
      <div className="providers__name">
        <h3 id={nameId}>{p.name}</h3>
        {mode === 'cloud' ? <span className="sr-only">Cloud provider</span> : <span className={`badge${mode === 'local' ? ' badge--local' : ''}`}>{ACCESS_LABEL[mode]}</span>}
      </div>

      <span className="providers__state" data-state={state} role="status">
        {status.glyph && <span className="providers__glyph"><StateIcon state={status.glyph} size={15} /></span>}
        {status.label}
      </span>
      <button
        type="button"
        className={`switch${p.enabled ? ' switch--on' : ''}`}
        role="switch"
        aria-checked={p.enabled}
        aria-label={`Enable ${p.name}`}
        onClick={props.onToggle}
        disabled={idle || testing}
      />

      <dl className="providers__facts">
        {facts.kind && <Fact label="Type" value={facts.kind} />}
        {facts.endpoint && <Fact label="Address" value={facts.endpoint} mono />}
        {facts.model && <Fact label={azure ? 'Deployment' : 'Model'} value={facts.model} mono />}
        {key !== 'none' && <Fact label="Key" value={KEY_FACT[key]} tone={key === 'missing' ? 'warn' : undefined} />}
      </dl>

      <div className="providers__actions">
        {state === 'needs-key' ? (
          <button type="button" className="btn btn--sm" onClick={() => props.onEdit('key')} disabled={idle}>Add key</button>
        ) : (
          <button
            type="button"
            className="btn btn--sm"
            onClick={props.onTest}
            disabled={idle || testing || !p.enabled}
            title={p.enabled ? undefined : 'Turn this provider on to test it'}
            aria-label={`Test connection to ${p.name}`}
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
        )}
        <button id={`provider-${p.id}-edit`} type="button" className="btn btn--ghost btn--sm" onClick={() => props.onEdit()} disabled={idle} aria-label={`Edit ${p.name}`}>
          <Pencil size={13} aria-hidden="true" /> Edit
        </button>
        <button id={`provider-${p.id}-remove`} type="button" className="providers__remove" onClick={props.onAskRemove} disabled={idle || confirmingRemove} aria-label={`Remove ${p.name}`} title="Remove">
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </div>

      {notice && (
        <Note
          provider={p}
          notice={notice}
          refreshing={refreshing}
          onRefresh={props.onRefresh}
          onTest={props.onTest}
          onEdit={() => props.onEdit()}
          onDismiss={props.onDismiss}
          disabled={idle}
        />
      )}

      {confirmingRemove && (
        <div className="confirm providers__confirm" role="group" aria-label={`Confirm removing ${p.name}`}>
          <p>Remove {p.name}{p.credentialRef ? ' and its saved key' : ''} from Cubex? Conversations that used it stay on this device.</p>
          <div className="confirm__actions">
            <button type="button" className="btn btn--danger btn--sm" onClick={props.onRemove} disabled={removing}>{removing ? 'Removing…' : 'Remove provider'}</button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={props.onCancelRemove} disabled={removing} autoFocus>Keep provider</button>
          </div>
        </div>
      )}
    </article>
  )
}

function Fact({ label, value, mono, tone }: { label: string; value: string; mono?: boolean; tone?: 'warn' }): JSX.Element {
  return (
    <div className="providers__fact" data-tone={tone}>
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : undefined}>{value}</dd>
    </div>
  )
}

interface NoteProps {
  provider: ProviderConfig
  notice: ProviderNotice
  refreshing: boolean
  disabled: boolean
  onRefresh: () => void
  onTest: () => void
  onEdit: () => void
  onDismiss: () => void
}

/** What the last test or refresh found, as a callout: what was checked and how it went, or what failed and how to fix it. */
function Note({ provider, notice, refreshing, disabled, onRefresh, onTest, onEdit, onDismiss }: NoteProps): JSX.Element {
  const noun = isAzure(provider) ? 'deployment' : 'model'
  const refreshable = hasModelList(provider)

  if (notice.kind === 'refresh') {
    const text = describeRefresh(notice.refresh, noun)
    const ok = notice.refresh.ok
    return (
      <div className={`callout ${ok ? 'callout--ok' : 'callout--error'} providers__note`} role={ok ? 'status' : 'alert'}>
        {ok ? <Check size={15} aria-hidden="true" /> : <TriangleAlert size={15} aria-hidden="true" />}
        <div className="callout__body">
          <strong>{text.title}</strong>
          <span className="providers__line">{text.body}</span>
          {text.fix && <span className="providers__line">{text.fix}</span>}
        </div>
        <div className="callout__actions">
          {ok ? (
            <button type="button" className="callout__action" onClick={onRefresh} disabled={refreshing || disabled}>{refreshing ? 'Refreshing…' : 'Refresh models'}</button>
          ) : (
            <>
              <button type="button" className="callout__action" onClick={onTest} disabled={disabled}>Test again</button>
              <button type="button" className="callout__action" onClick={onEdit} disabled={disabled}>Edit</button>
            </>
          )}
          <button type="button" className="callout__icon" onClick={onDismiss} aria-label="Dismiss this message"><X size={14} aria-hidden="true" /></button>
        </div>
      </div>
    )
  }

  const facts = describeResult(notice.result, provider)
  const measured = [facts.latency ? `Answered in ${facts.latency}.` : '', facts.models ? `${facts.models}.` : ''].filter(Boolean).join(' ')
  const missing = facts.ok && facts.defaultModelMissing
  const tone = !facts.ok ? 'callout--error' : missing ? 'callout--warn' : 'callout--ok'
  // The row already says "Connected" or "Could not connect"; the note leads with what was checked, or what went wrong.
  const lead = missing ? `Connected, but ${provider.defaultModel} is not offered` : facts.ok ? (facts.checked ?? facts.title) : (facts.message ?? facts.title)
  return (
    <div className={`callout ${tone} providers__note`} role={facts.ok ? 'status' : 'alert'}>
      {facts.ok && !missing ? <Check size={15} aria-hidden="true" /> : <TriangleAlert size={15} aria-hidden="true" />}
      <div className="callout__body">
        <strong>{lead}</strong>
        {facts.ok ? (
          <>
            {missing && facts.checked && <span className="providers__line">{facts.checked}</span>}
            {measured && <span className="providers__line">{measured}</span>}
            {facts.message && <span className="providers__line">{facts.message}</span>}
            {missing && <span className="providers__line">Choose another {noun} in Edit, or refresh the list if it was added recently.</span>}
          </>
        ) : (
          facts.fix && <span className="providers__line">{facts.fix}</span>
        )}
      </div>
      <div className="callout__actions">
        {facts.ok && refreshable && (
          <button type="button" className="callout__action" onClick={onRefresh} disabled={refreshing || disabled}>{refreshing ? 'Refreshing…' : 'Refresh models'}</button>
        )}
        {!facts.ok && (
          <>
            <button type="button" className="callout__action" onClick={onTest} disabled={disabled}>Test again</button>
            <button type="button" className="callout__action" onClick={onEdit} disabled={disabled}>Edit</button>
          </>
        )}
        {missing && (
          <button type="button" className="callout__action" onClick={onEdit} disabled={disabled}>Edit</button>
        )}
        <button type="button" className="callout__icon" onClick={onDismiss} aria-label="Dismiss this message"><X size={14} aria-hidden="true" /></button>
      </div>
    </div>
  )
}
