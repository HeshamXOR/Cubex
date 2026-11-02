import { useId, useMemo, useState } from 'react'
import { Check, ExternalLink, Info, TriangleAlert } from 'lucide-react'
import { catalogIdOfPeer, type AgentSignInResult, type KnownAgent } from '../../../../shared/agentCatalog'
import { PEER_LIMITS, newAcpPeer, newCliPeer, peerSlug, uniquePeerId, type PeerConfig } from '../../../../shared/peers'
import type { ProviderConfig } from '@core/types'
import { api } from '../../lib/api'
import { checkedAt, foundView, nodeLine, sortFound, type FoundEnvironment, type FoundState } from '../../lib/agentRows'
import { antigravityView, type AntigravityAction, type AntigravityButton } from '../../lib/antigravityRows'
import type { AntigravityState } from '../../lib/useAntigravity'
import type { AgentsDetectionState } from '../../lib/useAgentsDetection'
import { StateIcon } from '../../status/StatusIndicator'
import { AgentEditor } from './AgentEditor'
import { ArmedRemove, LoadError, Prose, Working } from './policyUi'

// --- Signing in ------------------------------------------------------------------------

/** Opens the agent's own sign-in in a terminal window, and keeps what the main process said about it. */
export function useSignIn(id: string, onStarted: () => void): { run: () => void; signing: boolean; result: AgentSignInResult | undefined; hide: () => void } {
  const [signing, setSigning] = useState(false)
  const [result, setResult] = useState<AgentSignInResult>()
  const run = (): void => {
    if (signing) return
    setSigning(true)
    setResult(undefined)
    api.signInAgent(id).then(
      (outcome) => {
        setResult(outcome)
        if (outcome.ok) onStarted()
      },
      (reason: unknown) => setResult({ ok: false, message: reason instanceof Error ? reason.message : String(reason) })
    ).finally(() => setSigning(false))
  }
  return { run, signing, result, hide: () => setResult(undefined) }
}

export function SignInButton({ name, signing, onClick, ghost = false }: { name: string; signing: boolean; onClick: () => void; ghost?: boolean }): JSX.Element {
  return (
    <button type="button" className={`btn btn--sm${ghost ? ' btn--ghost' : ''}`} onClick={onClick} disabled={signing} aria-label={`Sign in to ${name}`}>
      {signing ? <><StateIcon state="working" size={14} />Opening</> : 'Sign in'}
    </button>
  )
}

/** What opening the sign-in came to: where to finish it, or why it could not be opened and what to do. */
export function SignInNote({ result, onHide }: { result: AgentSignInResult; onHide: () => void }): JSX.Element {
  return (
    <div className={`callout ${result.ok ? 'callout--plain' : 'callout--warn'} pol-callout`} role="status">
      {result.ok ? <Info size={14} aria-hidden="true" /> : <TriangleAlert size={14} aria-hidden="true" />}
      <div className="callout__body"><Prose text={result.message} /></div>
      <div className="callout__actions">
        <button type="button" className="callout__action" onClick={onHide}>Hide</button>
      </div>
    </div>
  )
}

/** The account line of a row: a check when signed in, an amber triangle when the person has something to do. A note follows in quieter text. */
export function AccountLine({ state, text, note, className = 'found__account', working = false }: { state: FoundState; text: string; note?: string; className?: string; working?: boolean }): JSX.Element {
  return (
    <div className={className} data-state={state}>
      {working && <StateIcon state="working" size={13} />}
      {!working && state === 'signed-in' && <Check className="ok" size={13} aria-hidden="true" />}
      {!working && state === 'signed-out' && <TriangleAlert className="warn" size={13} aria-hidden="true" />}
      {!working && state === 'problem' && <TriangleAlert className="bad" size={13} aria-hidden="true" />}
      <span>{text}{note && !text.endsWith('.') ? '.' : ''}{note && <span className="found__note"> {note}</span>}</span>
    </div>
  )
}

// --- One agent --------------------------------------------------------------------------

interface RowProps {
  entry: KnownAgent
  environment: FoundEnvironment
  detection: AgentsDetectionState
  list: readonly PeerConfig[]
  providers: readonly ProviderConfig[]
  onAdd: (peer: PeerConfig) => void
}

function FoundRow({ entry, environment, detection, list, providers, onAdd }: RowProps): JSX.Element {
  const found = detection.byId.get(entry.id)
  const view = foundView(entry, found, environment)
  const [creating, setCreating] = useState<PeerConfig>()
  const signIn = useSignIn(entry.id, detection.expectChange)
  const editorId = useId()
  const installed = view.state !== 'missing'
  const added = list.some((peer) => catalogIdOfPeer(peer) === entry.id)
  const full = list.length >= PEER_LIMITS.peers
  // What to do first matters until the agent is added. For an agent whose account cannot be read it goes on the account line.
  const note = !added && view.state === 'unknown' ? view.hint : undefined
  const hint = !added && view.state !== 'unknown' ? view.hint : undefined

  const start = (): void => {
    setCreating(view.connection.kind === 'acp' ? newAcpPeer(view.connection.preset, list) : newCliPeer(view.connection.preset, list))
  }

  return (
    <li className="found__row" data-state={view.state}>
      <div className="found__line">
        <div className="found__main">
          <div className="found__name">
            {entry.name}
            <span className="found__sub">{entry.vendor}</span>
            {found?.version && <span className="found__sub found__version" title="Version">{found.version}</span>}
          </div>
          <AccountLine state={view.state} text={view.account} {...(note ? { note } : {})} />
          {view.where && <div className="found__text">{view.where}</div>}
          {view.capability && <div className="found__text">{view.capability}</div>}
          {hint && <div className="found__text"><Prose text={hint} /></div>}
        </div>
        <div className="found__actions">
          {view.signIn && <SignInButton name={entry.name} signing={signIn.signing} onClick={signIn.run} />}
          {!installed && (
            <a className="btn btn--sm found__get" href={entry.installUrl} target="_blank" rel="noreferrer">
              Get {entry.name}<ExternalLink size={12} aria-hidden="true" /><span className="sr-only"> (opens in your browser)</span>
            </a>
          )}
          {installed && added && <span className="found__added"><Check size={13} aria-hidden="true" />Added</span>}
          {installed && !added && (
            <button
              type="button"
              className="btn btn--sm"
              onClick={start}
              disabled={view.blocked || full || creating !== undefined}
              aria-label={`Add ${entry.name}`}
              aria-expanded={creating !== undefined}
              aria-controls={creating ? editorId : undefined}
            >
              Add
            </button>
          )}
        </div>
      </div>
      {signIn.result && view.state !== 'signed-in' && <SignInNote result={signIn.result} onHide={signIn.hide} />}
      {creating && (
        <div id={editorId}>
          <AgentEditor
            key={creating.id + creating.kind}
            base={creating}
            create
            providers={providers}
            // The key the model uses comes from the name that was typed, not from the preset.
            onSave={(peer) => { onAdd({ ...peer, id: uniquePeerId(peerSlug(peer.name), list.map((existing) => existing.id)) }); setCreating(undefined) }}
            onCancel={() => setCreating(undefined)}
          />
        </div>
      )}
    </li>
  )
}

// --- Antigravity -------------------------------------------------------------------------

/** How far the download is. A step with no figure moves a short bar back and forth, and stands still for people who asked for less motion. */
function InstallProgress({ fraction, label }: { fraction: number | null; label: string }): JSX.Element {
  return (
    <div className="found__progress">
      <div
        className="progress"
        role="progressbar"
        aria-label="Installing the Antigravity runtime"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={label}
        {...(fraction !== null ? { 'aria-valuenow': Math.round(fraction * 100) } : {})}
      >
        <div className={`progress__bar${fraction === null ? ' progress__bar--idle' : ''}`} style={fraction === null ? undefined : { width: `${Math.round(fraction * 100)}%` }} />
      </div>
      <span className="found__progresstext">{label}</span>
    </div>
  )
}

interface AntigravityRowProps {
  entry: KnownAgent
  antigravity: AntigravityState
  list: readonly PeerConfig[]
  providers: readonly ProviderConfig[]
  onAdd: (peer: PeerConfig) => void
}

/**
 * Antigravity is not a program on PATH. The desktop app has nothing Cubex can talk to, so this row installs Google's own agent
 * runtime when the person asks, signs in to it with a Google account, and only then offers to add it, in that order.
 */
function AntigravityRow({ entry, antigravity, list, providers, onAdd }: AntigravityRowProps): JSX.Element {
  const { status, error, refusal, pending, run, hideRefusal, reload } = antigravity
  const [creating, setCreating] = useState<PeerConfig>()
  const editorId = useId()
  const added = list.some((peer) => catalogIdOfPeer(peer) === entry.id)
  const full = list.length >= PEER_LIMITS.peers

  if (!status) {
    return (
      <li className="found__row" data-state="unknown">
        <div className="found__line">
          <div className="found__main">
            <div className="found__name">{entry.name}<span className="found__sub">{entry.vendor}</span></div>
            {error
              ? <LoadError title="Could not read the Antigravity setup" message={error} onRetry={reload} />
              : <div className="found__account" data-state="unknown"><StateIcon state="working" size={13} />Checking</div>}
          </div>
        </div>
      </li>
    )
  }

  const view = antigravityView(status)
  const renderButton = (item: AntigravityButton, primary: boolean): JSX.Element => {
    if (item.action === 'remove') {
      return <ArmedRemove key={item.action} subject="the Antigravity runtime and its Google sign-in" noun="runtime" disabled={pending} onConfirm={() => run('remove')} />
    }
    return (
      <button key={item.action} type="button" className={`btn btn--sm${primary ? '' : ' btn--ghost'}`} onClick={() => run(item.action as AntigravityAction)} disabled={pending}>
        {item.label}
      </button>
    )
  }
  const start = (): void => setCreating(newAcpPeer('agy-acp', list))

  return (
    <li className="found__row" data-state={view.state}>
      <div className="found__line">
        <div className="found__main">
          <div className="found__name">
            {entry.name}
            <span className="found__sub">{entry.vendor}</span>
            {status.runtime.installedVersion && <span className="found__sub found__version" title="Runtime version">{status.runtime.installedVersion}</span>}
          </div>
          <AccountLine state={view.state} text={view.account} working={view.working} {...(view.note ? { note: view.note } : {})} />
          {view.where && <div className="found__text">{view.where}</div>}
          {view.progress && <InstallProgress fraction={view.progress.fraction} label={view.progress.label} />}
          {view.intro.map((line) => <div key={line} className="found__text">{line}</div>)}
          {view.primary?.action === 'install' && (
            <div className="found__text">
              <a className="found__link" href={status.termsUrl} target="_blank" rel="noreferrer">Google&apos;s Antigravity terms<ExternalLink size={11} aria-hidden="true" /><span className="sr-only"> (opens in your browser)</span></a> apply to the runtime.
            </div>
          )}
        </div>
        <div className="found__actions">
          {view.primary && renderButton(view.primary, true)}
          {view.secondary.map((item) => renderButton(item, false))}
          {view.canAdd && added && <span className="found__added"><Check size={13} aria-hidden="true" />Added</span>}
          {view.canAdd && !added && (
            <button
              type="button"
              className="btn btn--sm"
              onClick={start}
              disabled={full || creating !== undefined}
              aria-label={`Add ${entry.name}`}
              aria-expanded={creating !== undefined}
              aria-controls={creating ? editorId : undefined}
            >
              Add
            </button>
          )}
        </div>
      </div>
      {refusal && <SignInNote result={refusal} onHide={hideRefusal} />}
      {creating && (
        <div id={editorId}>
          <AgentEditor
            key={creating.id + creating.kind}
            base={creating}
            create
            providers={providers}
            onSave={(peer) => { onAdd({ ...peer, id: uniquePeerId(peerSlug(peer.name), list.map((existing) => existing.id)) }); setCreating(undefined) }}
            onCancel={() => setCreating(undefined)}
          />
        </div>
      )}
    </li>
  )
}

// --- The list ---------------------------------------------------------------------------------

interface FoundProps {
  detection: AgentsDetectionState
  antigravity: AntigravityState
  list: readonly PeerConfig[]
  providers: readonly ProviderConfig[]
  onAdd: (peer: PeerConfig) => void
}

/**
 * The coding agents Cubex knows, which of them are on this computer, and who is signed in to each. Adding one sets up the
 * connection that fits what is installed. Nothing here signs in for the agent: the button opens the agent's own sign-in.
 */
export function FoundAgents({ detection, antigravity, list, providers, onAdd }: FoundProps): JSX.Element {
  const { detection: result, byId, checking, error, recheck } = detection
  // Antigravity counts as there when its desktop app or its runtime is, which the check of programs cannot see.
  const antigravityHere = antigravity.status ? antigravity.status.desktopApp || antigravity.status.runtime.installedVersion !== null : false
  const entries = useMemo(() => sortFound(byId, undefined, antigravityHere ? new Set(['antigravity']) : undefined), [byId, antigravityHere])
  const environment: FoundEnvironment = { nodeFound: result?.node.found ?? false, localOnly: result?.localOnly ?? false }
  const full = list.length >= PEER_LIMITS.peers
  return (
    <div className="pform found">
      <div className="found__head">
        <h4 className="pform__title">Found on this PC</h4>
        <div className="found__tools">
          {result && !checking && <span className="found__checked">Checked at {checkedAt(result.checkedAt)}</span>}
          <button type="button" className="btn btn--sm" onClick={recheck} disabled={checking}>
            {checking ? <><StateIcon state="working" size={14} />Checking</> : 'Check again'}
          </button>
        </div>
      </div>
      <p className="setgroup__note">
        Each of these is the vendor's own program, so it works with the login you already gave it, such as a Claude or ChatGPT subscription,
        and needs no API key. Cubex asks each one who is signed in and never reads, copies or stores the login. Most talk to Cubex over the
        Agent Client Protocol, which lets them give opinions and take on tasks. Antigravity is the exception: Cubex installs Google&apos;s agent
        runtime when you ask, and you sign in to it once with your Google account.
      </p>
      {error && <LoadError title="Could not check this computer" message={error} onRetry={recheck} />}
      {!result && !error && <Working>Looking for agents on this PC</Working>}
      {result && (
        <>
          <p className="setgroup__note found__node">{nodeLine(result.node)}</p>
          {result.localOnly && <p className="setgroup__note">Local-only mode is on, so Cubex looked for these programs without starting them. Versions and accounts are not shown.</p>}
          {full && <p className="setgroup__note">Up to {PEER_LIMITS.peers} agents can be saved. Remove one to add another.</p>}
          <ul className="found__rows" aria-busy={checking}>
            {entries.map((entry) => entry.id === 'antigravity'
              ? <AntigravityRow key={entry.id} entry={entry} antigravity={antigravity} list={list} providers={providers} onAdd={onAdd} />
              : <FoundRow key={entry.id} entry={entry} environment={environment} detection={detection} list={list} providers={providers} onAdd={onAdd} />
            )}
          </ul>
        </>
      )}
    </div>
  )
}
