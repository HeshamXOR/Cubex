import { useId, useMemo, useRef, useState } from 'react'
import { Check, TriangleAlert } from 'lucide-react'
import {
  DEFAULT_PEER_SETTINGS, PEER_LIMITS, PEER_PRESETS, clampRounds, describePeer, newCliPeer, newModelPeer, peerCommandLine, peerSlug, uniquePeerId, validatePeer,
  type CliPeer, type PeerConfig, type PeerPresetId, type PeerStatus, type PeerTestResult
} from '../../../../../shared/peers'
import type { ProviderConfig } from '@core/types'
import { api } from '../../../lib/api'
import { usePeersStatus } from '../../../lib/usePeersStatus'
import { selectableProvider, useStore } from '../../../state/store'
import { StateIcon } from '../../../status/StatusIndicator'
import { ArmedRemove, Disclosure, Empty, LoadError, Prose, took } from '../policyUi'
import { RowShell, SelectRow, Switch } from '../rows'
import type { SettingsSection } from '../registry'
import './agents.css'

// --- Tests ---------------------------------------------------------------------------

interface TestState {
  phase: 'idle' | 'testing' | 'done'
  result?: PeerTestResult
}

const failure = (reason: unknown): PeerTestResult => ({ ok: false, durationMs: 0, error: reason instanceof Error ? reason.message : String(reason) })

/** One test at a time for one row or form; a newer test replaces an older one still running. */
function usePeerTest(): { test: TestState; run: (peer: PeerConfig) => void; clear: () => void } {
  const [test, setTest] = useState<TestState>({ phase: 'idle' })
  const latest = useRef(0)
  const run = (peer: PeerConfig): void => {
    const mine = ++latest.current
    setTest({ phase: 'testing' })
    api.testPeer(peer).catch(failure).then((result) => {
      if (latest.current === mine) setTest({ phase: 'done', result })
    })
  }
  const clear = (): void => {
    latest.current++
    setTest({ phase: 'idle' })
  }
  return { test, run, clear }
}

function Output({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <>
      <Disclosure label="Program output" open={open} onToggle={() => setOpen(!open)} controls={id} />
      {open && <pre className="pol-pre" id={id} tabIndex={0} aria-label="Program output">{text}</pre>}
    </>
  )
}

/** What a test found: what the agent said, or why it did not answer and what to do. */
function TestResult({ result, onHide }: { result: PeerTestResult; onHide: () => void }): JSX.Element {
  const hide = (
    <div className="callout__actions">
      <button type="button" className="callout__action" onClick={onHide}>Hide</button>
    </div>
  )
  if (!result.ok) {
    return (
      <div className="callout callout--error pol-callout" role="status">
        <TriangleAlert size={14} aria-hidden="true" />
        <div className="callout__body">
          <strong>Did not answer</strong>
          <div><Prose text={result.error ?? 'The agent did not answer.'} /></div>
          {result.hint && <div className="callout__hint"><Prose text={result.hint} /></div>}
          {result.output && <Output text={result.output} />}
        </div>
        {hide}
      </div>
    )
  }
  return (
    <div className="callout callout--ok pol-callout" role="status">
      <Check size={14} aria-hidden="true" />
      <div className="callout__body">
        <strong>Answered in {took(result.durationMs)}</strong>
        {result.reply && <div className="callout__hint agents__reply">{result.reply}</div>}
      </div>
      {hide}
    </div>
  )
}

// --- The editor -----------------------------------------------------------------------

/** What the form holds as typed. Turned into a peer, and checked, only when the person saves or tests. */
interface Draft {
  name: string
  command: string
  readProject: boolean
  /** One argument per line. */
  args: string
  input: 'stdin' | 'argument'
  /** Names separated by commas or spaces. */
  passEnv: string
  providerId: string
  model: string
}

function draftOf(peer: PeerConfig): Draft {
  const cli = peer.kind === 'cli' ? peer : undefined
  return {
    name: peer.name,
    command: cli?.command ?? '',
    readProject: cli?.readProject === true,
    args: (cli?.args ?? []).join('\n'),
    input: cli?.input ?? 'stdin',
    passEnv: (cli?.passEnv ?? []).join(', '),
    providerId: peer.kind === 'model' ? peer.providerId : '',
    model: peer.kind === 'model' ? peer.model : ''
  }
}

/** The peer the form describes, as the main process will receive it. Unchecked: `validatePeer` decides. */
function peerOfDraft(base: PeerConfig, draft: Draft): unknown {
  if (base.kind === 'model') return { id: base.id, kind: 'model', enabled: base.enabled, name: draft.name, providerId: draft.providerId, model: draft.model }
  const passEnv = draft.passEnv.split(/[\s,]+/).filter(Boolean)
  return {
    id: base.id, kind: 'cli', enabled: base.enabled, preset: base.preset, name: draft.name, command: draft.command,
    ...(base.preset === 'claude-code' ? { readProject: draft.readProject } : {}),
    ...(base.preset === 'custom' ? { args: draft.args.split(/\r?\n/).filter((line) => line.length > 0), input: draft.input } : {}),
    ...(passEnv.length > 0 ? { passEnv } : {})
  }
}

/** The command as a person would type it, with arguments that have spaces or quotes quoted. */
function commandText(peer: CliPeer): string {
  const line = peerCommandLine(peer)
  const quote = (arg: string): string => (arg === '' || /[\s"]/.test(arg) ? JSON.stringify(arg) : arg)
  return [line.command, ...line.args.map(quote), ...(line.input === 'argument' ? ['<message>'] : [])].join(' ')
}

interface EditorProps {
  base: PeerConfig
  create: boolean
  providers: readonly ProviderConfig[]
  onSave: (peer: PeerConfig) => void
  onCancel: () => void
}

function AgentEditor({ base, create, providers, onSave, onCancel }: EditorProps): JSX.Element {
  const [draft, setDraft] = useState<Draft>(() => draftOf(base))
  const [problem, setProblem] = useState<string>()
  const { test, run, clear } = usePeerTest()
  const models = useStore((state) => state.models)
  const loadModels = useStore((state) => state.loadModels)
  const id = useId()
  const set = (patch: Partial<Draft>): void => { setDraft({ ...draft, ...patch }); setProblem(undefined) }
  const checked = validatePeer(peerOfDraft(base, draft))
  const testing = test.phase === 'testing'
  const listed = models[draft.providerId] ?? []

  const submit = (): void => {
    const result = validatePeer(peerOfDraft(base, draft))
    if (!result.ok) return setProblem(result.error)
    onSave(result.value)
  }
  const check = (): void => {
    const result = validatePeer(peerOfDraft(base, draft))
    if (!result.ok) return setProblem(result.error)
    run(result.value)
  }
  const chooseProvider = (providerId: string): void => {
    set({ providerId, model: '' })
    if (providerId) void loadModels(providerId).catch(() => undefined)
  }

  return (
    <form className="prow__editor agents__editor" onSubmit={(event) => { event.preventDefault(); submit() }}>
      <div className="pform__grid">
        <label className="pform__field" htmlFor={`${id}-name`}>
          <span>Name</span>
          <input id={`${id}-name`} className="input" value={draft.name} maxLength={PEER_LIMITS.name} placeholder={base.kind === 'model' ? 'GPT review' : 'Codex'} onChange={(e) => set({ name: e.target.value })} spellCheck={false} />
          <span className="pform__help">The model calls it this, and so does the thread.</span>
        </label>

        {base.kind === 'cli' && (
          <label className="pform__field" htmlFor={`${id}-command`}>
            <span>Program</span>
            <input id={`${id}-command`} className="input mono" value={draft.command} placeholder="codex" onChange={(e) => set({ command: e.target.value })} spellCheck={false} />
            <span className="pform__help">A name on your PATH, or the full path to the program.</span>
          </label>
        )}

        {base.kind === 'model' && (
          <>
            <label className="pform__field" htmlFor={`${id}-provider`}>
              <span>Provider</span>
              <select id={`${id}-provider`} className="select" value={draft.providerId} onChange={(e) => chooseProvider(e.target.value)}>
                <option value="">Choose a provider</option>
                {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
              </select>
            </label>
            <label className="pform__field" htmlFor={`${id}-model`}>
              <span>Model</span>
              {listed.length > 0
                ? (
                  <select id={`${id}-model`} className="select" value={draft.model} onChange={(e) => set({ model: e.target.value, name: draft.name || (listed.find((entry) => entry.id === e.target.value)?.displayName ?? e.target.value) })}>
                    <option value="">Choose a model</option>
                    {draft.model && !listed.some((entry) => entry.id === draft.model) && <option value={draft.model}>{draft.model}</option>}
                    {listed.map((entry) => <option key={entry.id} value={entry.id}>{entry.displayName || entry.id}</option>)}
                  </select>
                )
                : <input id={`${id}-model`} className="input mono" value={draft.model} placeholder="gpt-5" onChange={(e) => set({ model: e.target.value })} spellCheck={false} />}
              <span className="pform__help">Asked a plain question. It cannot see your project, and it has no tools.</span>
            </label>
          </>
        )}

        {base.kind === 'cli' && base.preset === 'claude-code' && (
          <div className="pform__field pform__field--wide">
            <RowShell label="Let it read this project" hint="Claude Code gets read-only tools in the open project. It is never allowed to change a file or run a command.">
              <Switch label="Let Claude Code read this project" on={draft.readProject} onChange={(on) => set({ readProject: on })} />
            </RowShell>
          </div>
        )}

        {base.kind === 'cli' && base.preset === 'custom' && (
          <>
            <div className="pform__field pform__field--wide">
              <label htmlFor={`${id}-args`}>Arguments</label>
              <textarea id={`${id}-args`} className="input mono" rows={3} value={draft.args} placeholder={'exec\n-'} onChange={(e) => set({ args: e.target.value })} spellCheck={false} aria-describedby={`${id}-args-help`} />
              <div id={`${id}-args-help`} className="pform__help">One argument per line, before the message. Leave blank for none.</div>
            </div>
            <label className="pform__field" htmlFor={`${id}-input`}>
              <span>Message goes to</span>
              <select id={`${id}-input`} className="select" value={draft.input} onChange={(e) => set({ input: e.target.value === 'argument' ? 'argument' : 'stdin' })}>
                <option value="stdin">Standard input</option>
                <option value="argument">The last argument</option>
              </select>
              <span className="pform__help">Standard input suits long messages. The last argument is limited to about 28,000 characters.</span>
            </label>
          </>
        )}

        {base.kind === 'cli' && (
          <label className="pform__field pform__field--wide" htmlFor={`${id}-env`}>
            <span>Variables to pass</span>
            <input id={`${id}-env`} className="input mono" value={draft.passEnv} placeholder="ANTHROPIC_API_KEY" onChange={(e) => set({ passEnv: e.target.value })} spellCheck={false} />
            <span className="pform__help">Cubex keeps anything that looks like a key or token out of the programs it starts. Name the variables this one needs, separated by commas. Most programs sign in on their own and need none.</span>
          </label>
        )}

        {base.kind === 'cli' && checked.ok && checked.value.kind === 'cli' && (
          <div className="pform__field pform__field--wide">
            <span>What Cubex runs</span>
            <code className="agents__command" title="Cubex starts this in an empty folder, without a shell.">{commandText(checked.value)}</code>
          </div>
        )}
      </div>
      {problem && <div className="pol-field-error" role="alert">{problem}</div>}
      <div className="pform__actions">
        <button type="submit" className="btn btn--primary btn--sm">{create ? 'Add agent' : 'Save changes'}</button>
        <button type="button" className="btn btn--sm" onClick={check} disabled={testing}>
          {testing ? <><StateIcon state="working" size={14} />Testing</> : 'Test'}
        </button>
        <button type="button" className="btn btn--sm btn--ghost" onClick={onCancel}>Cancel</button>
      </div>
      {test.phase === 'done' && test.result && <TestResult result={test.result} onHide={clear} />}
    </form>
  )
}

// --- A saved agent ----------------------------------------------------------------------

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
        <div className="prow__fix">{peer.kind === 'cli' ? 'Install it, or give its full path under Edit. If you just installed it, this page checks again when you return to it.' : 'Choose another provider under Edit.'}</div>
      </>
    )
  }
  return (
    <>
      <div className="prow__status">
        <Check className="ok" size={14} aria-hidden="true" />
        <span className="agents__found" title={status.path}>{status.path ? `Found at ${status.path}` : 'Provider is set up'}</span>
      </div>
      {peer.kind === 'cli' && programsOff && <div className="prow__fix">Local-only mode is on, so this program is not started.</div>}
    </>
  )
}

interface RowProps {
  peer: PeerConfig
  status: PeerStatus | undefined
  checking: boolean
  programsOff: boolean
  providers: readonly ProviderConfig[]
  onToggle: () => void
  onRemove: () => void
  onSave: (peer: PeerConfig) => void
}

function AgentRow({ peer, status, checking, programsOff, providers, onToggle, onRemove, onSave }: RowProps): JSX.Element {
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
          <div className="prow__name">{peer.name}<span className="prow__sub">{peer.kind === 'model' ? 'Model' : 'Program'}</span></div>
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

function AddAgent({ list, providers, presetFound, onAdd }: {
  list: readonly PeerConfig[]
  providers: readonly ProviderConfig[]
  presetFound: (preset: PeerPresetId) => boolean | undefined
  onAdd: (peer: PeerConfig) => void
}): JSX.Element {
  const [creating, setCreating] = useState<PeerConfig>()
  const full = list.length >= PEER_LIMITS.peers
  const choices: Array<{ key: string; title: string; text: string; state?: string; make: () => PeerConfig; opens: boolean }> = [
    ...PEER_PRESETS.map((preset) => {
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
      <h3 className="pform__title">Add an agent</h3>
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
  const signature = useMemo(() => JSON.stringify(list.map((peer) => [peer.id, peer.enabled, peer.kind === 'cli' ? peer.command : peer.providerId])), [list])
  const status = usePeersStatus(signature)
  const usable = useMemo(() => providers.filter((provider) => provider.enabled && selectableProvider(provider, settings)), [providers, settings])
  // A model peer's provider is named even when it is off, so the row can say which one is the problem.
  const writable = (peers: PeerConfig[]): void => void save({ peers: { ...current, list: peers } })

  return (
    <div>
      <p className="setgroup__note">
        Turn an agent on for a chat from the <span className="mono">+</span> menu in the composer. The model's message goes to that
        agent, so Cubex shows it and asks first, once for each agent in a reply.
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
            Add Claude Code, Antigravity, another program or a model below, test it, then turn it on for a chat.
          </Empty>
        )
        : (
          <ul className="prows">
            {list.map((peer) => (
              <AgentRow
                key={peer.id}
                peer={peer}
                status={status.byId.get(peer.id)}
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
      <AddAgent list={list} providers={usable} presetFound={(preset) => status.presets.get(preset)?.found} onAdd={(peer) => writable([...list, peer])} />
      <p className="setgroup__note agents__privacy">
        A program runs in an empty folder on this PC, so it can only see what the message carries. Claude Code can be allowed to read the open project, never to change it.
        Local-only mode turns programs off, because most of them send the message to a cloud service.
      </p>
    </div>
  )
}

export const section: SettingsSection = { id: 'agents', title: 'Other agents', page: 'agents', order: 700, Component: AgentsSection }
