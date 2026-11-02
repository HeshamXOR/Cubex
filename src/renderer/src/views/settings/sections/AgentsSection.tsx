import { useId, useMemo, useState } from 'react'
import { Check, TriangleAlert } from 'lucide-react'
import {
  ACP_PRESETS, DEFAULT_PEER_SETTINGS, PEER_LIMITS, PEER_PRESETS, clampRounds, describePeer, newAcpPeer, newCliPeer, newModelPeer,
  peerSlug, uniquePeerId,
  type AcpPresetId, type PeerConfig, type PeerPresetId, type PeerStatus
} from '../../../../../shared/peers'
import type { ProviderConfig } from '@core/types'
import { catalogIdOfPeer, knownAgent } from '../../../../../shared/agentCatalog'
import { foundView } from '../../../lib/agentRows'
import { antigravityAccount } from '../../../lib/antigravityRows'
import { useAgentsDetection, type AgentsDetectionState } from '../../../lib/useAgentsDetection'
import { useAntigravity, type AntigravityState } from '../../../lib/useAntigravity'
import { usePeersStatus } from '../../../lib/usePeersStatus'
import { selectableProvider, useStore } from '../../../state/store'
import { StateIcon } from '../../../status/StatusIndicator'
import { AgentEditor, TestResult, usePeerTest } from '../AgentEditor'
import { AccountLine, FoundAgents, SignInButton, SignInNote, useSignIn } from '../FoundAgents'
import { ArmedRemove, Empty, LoadError, Prose } from '../policyUi'
import { SelectRow } from '../rows'
import type { SettingsSection } from '../registry'
import './agents.css'

// --- A saved agent ----------------------------------------------------------------------

/** What to do about an agent that cannot be used on this computer. */
function missingFix(peer: PeerConfig): string {
  if (peer.kind === 'model') return 'Choose another provider under Edit.'
  if (peer.kind === 'acp' && peer.preset === 'agy-acp') return 'Find Antigravity under "Found on this PC" below and choose "Install the runtime". This page checks again when the install is done.'
  if (peer.kind === 'acp' && peer.command === 'npx') return 'This agent runs through npx, which comes with Node.js. Install Node.js, then this page checks again when you return to it.'
  return 'Install it, or give its full path under Edit. If you just installed it, this page checks again when you return to it.'
}

function Status({ peer, status, checking, programsOff }: { peer: PeerConfig; status: PeerStatus | undefined; checking: boolean; programsOff: boolean }): JSX.Element {
  if (!peer.enabled) return <div className="prow__status">Off. Turn it on to offer it in chats.</div>
  if (!status) return checking ? <div className="prow__status" role="status"><StateIcon state="working" size={14} />Checking</div> : <div className="prow__status">Status unknown</div>
  if (!status.found) {
    return (
      <>
        <div className="prow__status">
          <TriangleAlert className="bad" size={14} aria-hidden="true" />
          <span className="prow__why"><Prose text={status.problem ?? 'This agent cannot be used.'} /></span>
        </div>
        <div className="prow__fix">{missingFix(peer)}</div>
      </>
    )
  }
  return (
    <>
      <div className="prow__status">
        <Check className="ok" size={14} aria-hidden="true" />
        <span className="agents__found" title={status.path}>{status.path ? `Found at ${status.path}` : 'Provider is set up'}</span>
      </div>
      {peer.kind !== 'model' && programsOff && <div className="prow__fix">Local-only mode is on, so this program is not started.</div>}
    </>
  )
}

/** Who a saved Antigravity agent is signed in as: its runtime keeps the Google sign-in, so the answer comes from the runtime, not from a program on PATH. */
function SavedAntigravity({ antigravity }: { antigravity: AntigravityState }): JSX.Element | null {
  const account = antigravity.status ? antigravityAccount(antigravity.status) : undefined
  if (!account) return null
  return (
    <>
      <div className="prow__account">
        <AccountLine className="prow__status" state={account.state} text={account.text} />
        {account.action && account.actionLabel && (
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => antigravity.run(account.action!)} disabled={antigravity.pending}>{account.actionLabel}</button>
        )}
      </div>
      {antigravity.refusal && <SignInNote result={antigravity.refusal} onHide={antigravity.hideRefusal} />}
    </>
  )
}

/** Who a saved agent is signed in as, for a program Cubex knows how to ask. Nothing for a model or a program it does not know. */
function SavedAccount({ peer, detection, antigravity }: { peer: PeerConfig; detection: AgentsDetectionState; antigravity: AntigravityState }): JSX.Element | null {
  const id = catalogIdOfPeer(peer)
  const entry = id ? knownAgent(id) : undefined
  const signIn = useSignIn(id ?? '', detection.expectChange)
  const result = detection.detection
  if (peer.kind === 'acp' && peer.preset === 'agy-acp') return <SavedAntigravity antigravity={antigravity} />
  // The agy command line has no account Cubex can read.
  if (id === 'antigravity') return null
  if (!entry || !result) return null
  const view = foundView(entry, detection.byId.get(entry.id), { nodeFound: result.node.found, localOnly: result.localOnly })
  if (view.state === 'missing') return null
  return (
    <>
      <div className="prow__account">
        <AccountLine className="prow__status" state={view.state} text={view.account} />
        {view.signIn && <SignInButton name={peer.name} signing={signIn.signing} onClick={signIn.run} ghost />}
      </div>
      {signIn.result && view.state !== 'signed-in' && <SignInNote result={signIn.result} onHide={signIn.hide} />}
    </>
  )
}

interface RowProps {
  peer: PeerConfig
  status: PeerStatus | undefined
  detection: AgentsDetectionState
  antigravity: AntigravityState
  checking: boolean
  programsOff: boolean
  providers: readonly ProviderConfig[]
  onToggle: () => void
  onRemove: () => void
  onSave: (peer: PeerConfig) => void
}

function AgentRow({ peer, status, detection, antigravity, checking, programsOff, providers, onToggle, onRemove, onSave }: RowProps): JSX.Element {
  const { test, run, clear } = usePeerTest()
  const [editing, setEditing] = useState(false)
  const editorId = useId()
  const testing = test.phase === 'testing'
  const providerName = peer.kind === 'model' ? providers.find((provider) => provider.id === peer.providerId)?.name : undefined
  const line = describePeer(peer, providerName)
  return (
    <li className="prow" aria-busy={testing}>
      <div className="prow__head">
        <button type="button" className={`switch ${peer.enabled ? 'switch--on' : ''}`} onClick={onToggle} role="switch" aria-checked={peer.enabled} aria-label={`Offer ${peer.name} in chats`} title={peer.enabled ? 'On' : 'Off'} />
        <div className="prow__title">
          <div className="prow__name">{peer.name}<span className="prow__sub">{peer.kind === 'model' ? 'Model' : peer.kind === 'acp' ? 'ACP agent' : 'Program'}</span></div>
          <div className="prow__cmd" title={line}>{line}</div>
        </div>
        <div className="prow__actions">
          <button type="button" className="btn btn--sm" onClick={() => run(peer)} disabled={testing}>
            {testing ? <><StateIcon state="working" size={14} />Testing</> : 'Test'}
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setEditing(!editing)} aria-expanded={editing} aria-controls={editing ? editorId : undefined}>Edit</button>
          <ArmedRemove subject={peer.name} noun="agent" onConfirm={onRemove} />
        </div>
      </div>
      <div className="prow__below">
        <Status peer={peer} status={status} checking={checking} programsOff={programsOff} />
        {peer.enabled && status?.found === true && <SavedAccount peer={peer} detection={detection} antigravity={antigravity} />}
        {test.phase === 'done' && test.result && <TestResult result={test.result} onHide={clear} />}
        {editing && (
          <div id={editorId}>
            <AgentEditor base={peer} create={false} providers={providers} onSave={(next) => { onSave(next); setEditing(false); clear() }} onCancel={() => setEditing(false)} />
          </div>
        )}
      </div>
    </li>
  )
}

// --- Adding one -------------------------------------------------------------------------

function AddAgent({ list, providers, presetFound, acpFound, onAdd }: {
  list: readonly PeerConfig[]
  providers: readonly ProviderConfig[]
  presetFound: (preset: PeerPresetId) => boolean | undefined
  acpFound: (preset: AcpPresetId) => boolean | undefined
  onAdd: (peer: PeerConfig) => void
}): JSX.Element {
  const [creating, setCreating] = useState<PeerConfig>()
  const full = list.length >= PEER_LIMITS.peers
  const acpKnown = ACP_PRESETS.filter((preset) => preset.id !== 'custom')
  const acpInstalled = acpKnown.filter((preset) => acpFound(preset.id))
  const acpChecked = acpKnown.some((preset) => acpFound(preset.id) !== undefined)
  const choices: Array<{ key: string; title: string; text: string; state?: string; make: () => PeerConfig; opens: boolean }> = [
    // Claude Code and Antigravity are added from "Found on this PC", which sets up the connection that fits what is installed.
    ...PEER_PRESETS.filter((preset) => preset.id === 'custom').map((preset) => {
      const found = preset.id === 'custom' ? undefined : presetFound(preset.id)
      return {
        key: preset.id,
        title: preset.label,
        text: preset.description,
        ...(found === undefined ? {} : { state: found ? 'Found on this computer' : 'Not found on this computer' }),
        make: (): PeerConfig => newCliPeer(preset.id, list),
        opens: preset.id === 'custom'
      }
    }),
    {
      key: 'acp',
      title: 'An ACP agent',
      text: 'Gemini, Codex, Copilot, OpenCode, or any agent that speaks the Agent Client Protocol.',
      ...(acpChecked ? { state: `${acpInstalled.length} of ${acpKnown.length} found on this computer` } : {}),
      // The first one that is installed here, so the form opens on something that works.
      make: (): PeerConfig => newAcpPeer((acpInstalled[0] ?? acpKnown[0])!.id, list),
      opens: true
    },
    {
      key: 'model',
      title: 'A model',
      text: 'A model from one of your providers, asked a plain question.',
      state: providers.length > 0 ? undefined : 'No provider is set up',
      make: (): PeerConfig => ({ ...newModelPeer('', '', '', list), providerId: '', model: '', name: '' }),
      opens: true
    }
  ]
  return (
    <div className="pform">
      <h4 className="pform__title">Add an agent</h4>
      <p className="pform__help">For a model, a program that is not listed above, or any agent that speaks the Agent Client Protocol.</p>
      {full
        ? <p className="pform__help">Remove an agent to add another. Up to {PEER_LIMITS.peers} can be saved.</p>
        : (
          <div className="agents__choices">
            {choices.map((choice) => (
              <button key={choice.key} type="button" className="agentchoice" onClick={() => (choice.opens ? setCreating(choice.make()) : onAdd(choice.make()))} disabled={choice.key === 'model' && providers.length === 0}>
                <span className="agentchoice__title">{choice.title}</span>
                <span className="agentchoice__text">{choice.text}</span>
                {choice.state && <span className="agentchoice__state">{choice.state}</span>}
              </button>
            ))}
          </div>
        )}
      {creating && (
        <div className="agents__new">
          <AgentEditor
            key={creating.id + creating.kind}
            base={creating}
            create
            providers={providers}
            // The key the model uses comes from the name that was typed, not from a placeholder.
            onSave={(peer) => { onAdd({ ...peer, id: uniquePeerId(peerSlug(peer.name), list.map((entry) => entry.id)) }); setCreating(undefined) }}
            onCancel={() => setCreating(undefined)}
          />
        </div>
      )}
    </div>
  )
}

// --- The group ----------------------------------------------------------------------------

const ROUND_OPTIONS: Array<[string, string]> = Array.from({ length: PEER_LIMITS.rounds.max - PEER_LIMITS.rounds.min + 1 }, (_, index) => {
  const count = PEER_LIMITS.rounds.min + index
  return [String(count), count === 1 ? '1 message' : `${count} messages`]
})

function AgentsSection(): JSX.Element {
  const settings = useStore((state) => state.settings)
  const save = useStore((state) => state.saveSettings)
  const providers = useStore((state) => state.providers)
  const current = settings?.peers ?? DEFAULT_PEER_SETTINGS
  const list = current.list
  const antigravity = useAntigravity()
  // The runtime of an Antigravity agent comes and goes with the install, so a change of it asks again which agents can be used.
  const installedRuntime = antigravity.status?.runtime.installedVersion ?? ''
  const signature = useMemo(() => JSON.stringify([installedRuntime, list.map((peer) => [peer.id, peer.enabled, peer.kind === 'model' ? peer.providerId : peer.command])]), [list, installedRuntime])
  const status = usePeersStatus(signature)
  const detection = useAgentsDetection()
  const usable = useMemo(() => providers.filter((provider) => provider.enabled && selectableProvider(provider, settings)), [providers, settings])
  // A model peer's provider is named even when it is off, so the row can say which one is the problem.
  const writable = (peers: PeerConfig[]): void => void save({ peers: { ...current, list: peers } })

  return (
    <div>
      <p className="setgroup__note">
        Turn an agent on for a chat from the <span className="mono">+</span> menu in the composer. The model can then ask it for an opinion
        or, if you allowed it, hand it a whole task. Cubex shows what is sent and asks first.
      </p>
      <SelectRow
        label="Most messages to one agent per reply"
        hint="How long a back and forth may run before the model has to say what was agreed."
        value={String(current.maxRounds)}
        options={ROUND_OPTIONS}
        onChange={(value) => void save({ peers: { ...current, maxRounds: clampRounds(Number(value)) } })}
      />
      {status.error && <LoadError title="Could not check the agents" message={status.error} onRetry={status.reload} />}
      {list.length === 0
        ? (
          <Empty title="No other agents yet">
            Add one of the agents found on this PC below, or a model or another program, test it, then turn it on for a chat.
          </Empty>
        )
        : (
          <ul className="prows">
            {list.map((peer) => (
              <AgentRow
                key={peer.id}
                peer={peer}
                status={status.byId.get(peer.id)}
                detection={detection}
                antigravity={antigravity}
                checking={status.loading}
                programsOff={status.localOnly}
                providers={providers}
                onToggle={() => writable(list.map((entry) => (entry.id === peer.id ? { ...entry, enabled: !entry.enabled } : entry)))}
                onRemove={() => writable(list.filter((entry) => entry.id !== peer.id))}
                onSave={(next) => writable(list.map((entry) => (entry.id === peer.id ? next : entry)))}
              />
            ))}
          </ul>
        )}
      <FoundAgents detection={detection} antigravity={antigravity} list={list} providers={usable} onAdd={(peer) => writable([...list, peer])} />
      <AddAgent
        list={list}
        providers={usable}
        presetFound={(preset) => status.presets.get(preset)?.found}
        acpFound={(preset) => status.acpPresets.get(preset)?.found}
        onAdd={(peer) => writable([...list, peer])}
      />
      <p className="setgroup__note agents__privacy">
        A program asked for an opinion runs in an empty folder on this PC, so it can only see what the message carries. Claude Code and ACP agents can be allowed to read the open project,
        and then still never change it or run a command. An agent that takes on a task works inside the open project, and Cubex asks before each change it makes or command it runs,
        as your permission mode says. An ACP agent asked for opinions stays running between messages and stops after ten quiet minutes; a task gets its own copy, which ends with the task.
        Local-only mode turns programs off, because most of them send the message to a cloud service.
      </p>
    </div>
  )
}

export const section: SettingsSection = { id: 'agents', title: 'Other agents', page: 'agents', order: 700, Component: AgentsSection }
