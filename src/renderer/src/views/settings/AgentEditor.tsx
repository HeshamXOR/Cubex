import { useId, useRef, useState } from 'react'
import { Check, TriangleAlert } from 'lucide-react'
import {
  ACP_PRESETS, PEER_LIMITS, acpPreset, commandLineText, peerCommandLine, validatePeer,
  type AcpPeer, type AcpPresetId, type CliPeer, type PeerConfig, type PeerTestResult
} from '../../../../shared/peers'
import type { ProviderConfig } from '@core/types'
import { api } from '../../lib/api'
import { useStore } from '../../state/store'
import { StateIcon } from '../../status/StatusIndicator'
import { Disclosure, Prose, took } from './policyUi'
import { RowShell, Switch } from './rows'
import './sections/agents.css'

// --- Tests ---------------------------------------------------------------------------

export interface TestState {
  phase: 'idle' | 'testing' | 'done'
  result?: PeerTestResult
}

const failure = (reason: unknown): PeerTestResult => ({ ok: false, durationMs: 0, error: reason instanceof Error ? reason.message : String(reason) })

/** One test at a time for one row or form; a newer test replaces an older one still running. */
export function usePeerTest(): { test: TestState; run: (peer: PeerConfig) => void; clear: () => void } {
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
export function TestResult({ result, onHide }: { result: PeerTestResult; onHide: () => void }): JSX.Element {
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
        {result.note && <div>{result.note}</div>}
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
  /** ACP agents only: whether the model may hand it whole tasks. */
  canDelegate: boolean
  /** ACP agents only: which agent the form is for, and how to sign in to it. */
  acpPreset: AcpPresetId
  authMethod: string
}

function draftOf(peer: PeerConfig): Draft {
  const program = peer.kind === 'model' ? undefined : peer
  return {
    name: peer.name,
    command: program?.command ?? '',
    readProject: program?.readProject === true,
    args: (program?.args ?? []).join('\n'),
    input: peer.kind === 'cli' ? peer.input ?? 'stdin' : 'stdin',
    passEnv: (program?.passEnv ?? []).join(', '),
    providerId: peer.kind === 'model' ? peer.providerId : '',
    model: peer.kind === 'model' ? peer.model : '',
    canDelegate: peer.kind === 'acp' && peer.canDelegate === true,
    acpPreset: peer.kind === 'acp' ? peer.preset : 'custom',
    authMethod: peer.kind === 'acp' ? peer.authMethod ?? '' : ''
  }
}

/** The peer the form describes, as the main process will receive it. Unchecked: `validatePeer` decides. */
function peerOfDraft(base: PeerConfig, draft: Draft): unknown {
  if (base.kind === 'model') return { id: base.id, kind: 'model', enabled: base.enabled, name: draft.name, providerId: draft.providerId, model: draft.model }
  const passEnv = draft.passEnv.split(/[\s,]+/).filter(Boolean)
  if (base.kind === 'acp') {
    return {
      id: base.id, kind: 'acp', enabled: base.enabled, preset: draft.acpPreset, name: draft.name, command: draft.command,
      args: draft.args.split(/\r?\n/).filter((line) => line.length > 0), readProject: draft.readProject, canDelegate: draft.canDelegate, authMethod: draft.authMethod,
      ...(passEnv.length > 0 ? { passEnv } : {})
    }
  }
  return {
    id: base.id, kind: 'cli', enabled: base.enabled, preset: base.preset, name: draft.name, command: draft.command,
    ...(base.preset === 'claude-code' ? { readProject: draft.readProject } : {}),
    ...(base.preset === 'custom' ? { args: draft.args.split(/\r?\n/).filter((line) => line.length > 0), input: draft.input } : {}),
    ...(passEnv.length > 0 ? { passEnv } : {})
  }
}

/** The command as a person would type it, with arguments that have spaces or quotes quoted. */
function commandText(peer: CliPeer | AcpPeer): string {
  if (peer.kind === 'acp') return commandLineText(peer.command, peer.args ?? [])
  const line = peerCommandLine(peer)
  return commandLineText(line.command, [...line.args, ...(line.input === 'argument' ? ['<message>'] : [])])
}

interface EditorProps {
  base: PeerConfig
  create: boolean
  providers: readonly ProviderConfig[]
  onSave: (peer: PeerConfig) => void
  onCancel: () => void
}

/** The variable an agent most likely needs, shown as the example in "Variables to pass". */
const ACP_ENV_EXAMPLE: Partial<Record<AcpPresetId, string>> = { 'claude-direct': 'ANTHROPIC_API_KEY', claude: 'ANTHROPIC_API_KEY', codex: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', copilot: 'GH_TOKEN', cursor: 'CURSOR_API_KEY' }
function envExample(base: PeerConfig, preset: AcpPresetId): string {
  return base.kind === 'acp' ? ACP_ENV_EXAMPLE[preset] ?? 'API_KEY' : 'ANTHROPIC_API_KEY'
}

export function AgentEditor({ base, create, providers, onSave, onCancel }: EditorProps): JSX.Element {
  const [draft, setDraft] = useState<Draft>(() => draftOf(base))
  const [problem, setProblem] = useState<string>()
  // What rarely changes is folded away. An agent that has no program yet needs it, and so does a form that failed its checks.
  const [more, setMore] = useState(() => base.kind === 'acp' && (base.command === '' || base.preset === 'custom'))
  const { test, run, clear } = usePeerTest()
  const models = useStore((state) => state.models)
  const loadModels = useStore((state) => state.loadModels)
  const id = useId()
  const set = (patch: Partial<Draft>): void => { setDraft({ ...draft, ...patch }); setProblem(undefined) }
  const checked = validatePeer(peerOfDraft(base, draft))
  const testing = test.phase === 'testing'
  const listed = models[draft.providerId] ?? []

  /** Say what is wrong. Unless it is the name, which is never folded away, it may be in a field that is. */
  const refuse = (error: string): void => {
    setProblem(error)
    if (draft.name.trim()) setMore(true)
  }
  const submit = (): void => {
    const result = validatePeer(peerOfDraft(base, draft))
    if (!result.ok) return refuse(result.error)
    onSave(result.value)
  }
  const check = (): void => {
    const result = validatePeer(peerOfDraft(base, draft))
    if (!result.ok) return refuse(result.error)
    run(result.value)
  }
  const chooseProvider = (providerId: string): void => {
    set({ providerId, model: '' })
    if (providerId) void loadModels(providerId).catch(() => undefined)
  }
  // A preset brings its program and arguments, and its name when the name is still the previous preset's own.
  const chooseAcpPreset = (preset: AcpPresetId): void => {
    const entry = acpPreset(preset)
    set({ acpPreset: preset, command: entry.command, args: entry.args.join('\n'), name: draft.name === '' || draft.name === acpPreset(draft.acpPreset).name ? entry.name : draft.name })
    // Another agent has no program yet, and the form asks for it.
    if (preset === 'custom') setMore(true)
  }

  // Shared by the programs of both kinds. An agent's own are folded away.
  const programField = (
    <label className="pform__field" htmlFor={`${id}-command`}>
      <span>Program</span>
      <input id={`${id}-command`} className="input mono" value={draft.command} placeholder={base.kind === 'acp' ? 'gemini' : 'codex'} onChange={(e) => set({ command: e.target.value })} spellCheck={false} />
      <span className="pform__help">A name on your PATH, or the full path to the program.</span>
    </label>
  )
  const envField = (
    <label className="pform__field pform__field--wide" htmlFor={`${id}-env`}>
      <span>Variables to pass</span>
      <input id={`${id}-env`} className="input mono" value={draft.passEnv} placeholder={envExample(base, draft.acpPreset)} onChange={(e) => set({ passEnv: e.target.value })} spellCheck={false} />
      <span className="pform__help">Cubex keeps anything that looks like a key or token out of the programs it starts, so an agent uses the sign-in it already has, such as a Claude or ChatGPT subscription. Name a variable here only to give the agent an API key from Cubex's own environment. Separate names with commas.</span>
    </label>
  )

  return (
    <form className="prow__editor agents__editor" onSubmit={(event) => { event.preventDefault(); submit() }}>
      <div className="pform__grid">
        <label className="pform__field" htmlFor={`${id}-name`}>
          <span>Name</span>
          <input id={`${id}-name`} className="input" value={draft.name} maxLength={PEER_LIMITS.name} placeholder={base.kind === 'model' ? 'GPT review' : 'Codex'} onChange={(e) => set({ name: e.target.value })} spellCheck={false} />
          <span className="pform__help">The model calls it this, and so does the thread.</span>
        </label>

        {base.kind === 'cli' && programField}

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

        {base.kind === 'acp' && (
          <>
            <label className="pform__field" htmlFor={`${id}-agent`}>
              <span>Agent</span>
              <select id={`${id}-agent`} className="select" value={draft.acpPreset} onChange={(e) => chooseAcpPreset(e.target.value as AcpPresetId)}>
                {ACP_PRESETS.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
              </select>
              <span className="pform__help">{acpPreset(draft.acpPreset).description}</span>
            </label>
            <div className="pform__field pform__field--wide">
              <RowShell label="Let it read this project" hint="When the model asks it for an opinion, the agent can read files in the open project. It is never allowed to change a file or run a command then.">
                <Switch label={`Let ${draft.name || 'the agent'} read this project`} on={draft.readProject} onChange={(on) => set({ readProject: on })} />
              </RowShell>
            </div>
            <div className="pform__field pform__field--wide">
              <RowShell label="Let it take on tasks" hint="The model can hand it a whole task, such as fixing a bug or writing tests. It works in the open project, and each change or command it asks for is put to you by your permission mode. It cannot change anything outside the project.">
                <Switch label={`Let ${draft.name || 'the agent'} take on tasks`} on={draft.canDelegate} onChange={(on) => set({ canDelegate: on })} />
              </RowShell>
              {draft.canDelegate && <span className="pform__help">An agent with no mode that asks before it changes things cannot be held to your permission mode, so it is given only tasks that read, such as research and review. Test shows which kind this one is.</span>}
            </div>
          </>
        )}

        {base.kind === 'cli' && base.preset === 'claude-code' && (
          <div className="pform__field pform__field--wide">
            <RowShell label="Let it read this project" hint="Claude Code gets read-only tools in the open project. It is never allowed to change a file or run a command. To let it take on tasks, add Claude Code again from Found on this PC.">
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

        {base.kind === 'cli' && envField}

        {base.kind !== 'model' && checked.ok && checked.value.kind !== 'model' && (
          <div className="pform__field pform__field--wide">
            <span>What Cubex runs</span>
            <code className="agents__command" title={checked.value.kind === 'acp' ? 'Cubex starts this without a shell, and keeps it running while a chat talks to it.' : 'Cubex starts this in an empty folder, without a shell.'}>{commandText(checked.value)}</code>
          </div>
        )}

        {base.kind === 'acp' && (
          <>
            <div className="pform__field pform__field--wide">
              <Disclosure label="Program, variables and sign-in method" open={more} onToggle={() => setMore(!more)} controls={`${id}-more`} />
            </div>
            {more && (
              <div className="pform__more" id={`${id}-more`}>
                {programField}
                <div className="pform__field pform__field--wide">
                  <label htmlFor={`${id}-args`}>Arguments</label>
                  <textarea id={`${id}-args`} className="input mono" rows={2} value={draft.args} placeholder={draft.acpPreset === 'claude-direct' ? '--model=sonnet' : '--acp'} onChange={(e) => set({ args: e.target.value })} spellCheck={false} aria-describedby={`${id}-args-help`} />
                  <div id={`${id}-args-help`} className="pform__help">
                    {draft.acpPreset === 'claude-direct'
                      ? 'Cubex starts Claude Code with the options it needs. The only one you can add is --model, with the name of a model.'
                      : 'One argument per line. They make the program speak the Agent Client Protocol.'}
                  </div>
                </div>
                {envField}
                <label className="pform__field pform__field--wide" htmlFor={`${id}-auth`}>
                  <span>Sign-in method</span>
                  <input id={`${id}-auth`} className="input mono" value={draft.authMethod} placeholder="Optional" onChange={(e) => set({ authMethod: e.target.value })} spellCheck={false} />
                  <span className="pform__help">Only for an agent that asks to be signed in and offers more than one way. The error message lists them. Most agents use the sign-in the program already has.</span>
                </label>
              </div>
            )}
          </>
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
