import { useId, useMemo, useRef, useState } from 'react'
import { Check, TriangleAlert } from 'lucide-react'
import type { McpServerConfig } from '../../../../../shared/settings'
import type { McpServerStatus, McpTestRequest, McpTestResult, McpToolSummary } from '../../../../../shared/policy'
import { checkDrafts, draftsFromServer, planEnvChange, sameVariables, savedVariables, testVariables, type EnvChange, type EnvDraft } from '../../../lib/envDrafts'
import { api, relativeTime } from '../../../lib/api'
import { plural } from '../../../lib/format'
import { parseMcpArguments } from '../../../lib/mcpArguments'
import { useMcpStatus } from '../../../lib/useMcpStatus'
import { useStore } from '../../../state/store'
import { StateIcon } from '../../../status/StatusIndicator'
import { EnvEditor, EnvHelp } from '../EnvEditor'
import { ArmedRemove, Disclosure, Empty, LoadError, Prose, took } from '../policyUi'
import type { SettingsSection } from '../registry'

// --- Connection tests -------------------------------------------------------------

interface TestState {
  phase: 'idle' | 'testing' | 'done'
  result?: McpTestResult
}

const failure = (reason: unknown): McpTestResult => ({
  ok: false, durationMs: 0, tools: [], toolCount: 0, error: reason instanceof Error ? reason.message : String(reason)
})

/** One connection test at a time for one row or form; a newer test replaces an older one still running. */
function useConnectionTest(): { test: TestState; run: (request: McpTestRequest) => void; clear: () => void } {
  const [test, setTest] = useState<TestState>({ phase: 'idle' })
  const latest = useRef(0)
  const run = (request: McpTestRequest): void => {
    const mine = ++latest.current
    setTest({ phase: 'testing' })
    api.testMcpServer(request).catch(failure).then((result) => {
      if (latest.current === mine) setTest({ phase: 'done', result })
    })
  }
  const clear = (): void => {
    latest.current++
    setTest({ phase: 'idle' })
  }
  return { test, run, clear }
}

/** The command as a person would type it: arguments with spaces or quotes are quoted. */
function commandLine(command: string, args: readonly string[] | undefined): string {
  return [command, ...(args ?? []).map((arg) => (arg === '' || /[\s"]/.test(arg) ? JSON.stringify(arg) : arg))].join(' ')
}

function ToolList({ id, tools, total }: { id: string; tools: readonly McpToolSummary[]; total: number }): JSX.Element {
  return (
    <>
      <ul className="tools" id={id} aria-label="Tools this server offers">
        {tools.map((tool) => (
          <li className="tool" key={tool.name}>
            <span className="tool__name">{tool.name}</span>
            <span className={`tool__desc ${tool.description ? '' : 'tool__desc--none'}`}>{tool.description ?? 'No description'}</span>
          </li>
        ))}
      </ul>
      {total > tools.length && <p className="pform__help">Showing the first {tools.length} of {total} tools.</p>}
    </>
  )
}

function Output({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <>
      <Disclosure label="Server output" open={open} onToggle={() => setOpen(!open)} controls={id} />
      {open && <pre className="pol-pre" id={id} tabIndex={0} aria-label="Server output">{text}</pre>}
    </>
  )
}

/** What a connection test found: the server and its tools, or why it did not connect and what to do. */
function TestResult({ result, onHide }: { result: McpTestResult; onHide: () => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const id = useId()
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
          <strong>Could not connect</strong>
          <div><Prose text={result.error ?? 'The server did not answer.'} /></div>
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
        <strong>Connected in {took(result.durationMs)}</strong>
        {result.server && (
          <div className="callout__hint">
            {result.server.name}{result.server.version ? ` ${result.server.version}` : ''}
            {result.protocolVersion ? `, protocol ${result.protocolVersion}` : ''}
          </div>
        )}
        {result.toolCount === 0
          ? <div className="callout__hint">The server connected but offers no tools.</div>
          : <Disclosure label={plural(result.toolCount, 'tool')} open={open} onToggle={() => setOpen(!open)} controls={id} />}
        {open && <ToolList id={id} tools={result.tools} total={result.toolCount} />}
        {result.output && <Output text={result.output} />}
      </div>
      {hide}
    </div>
  )
}

// --- Secrets -----------------------------------------------------------------------

/**
 * Put secret values in the credential store, one by one. A refusal comes back as a sentence naming the
 * variable. For a server that does not exist yet, whatever was stored before the refusal is taken out
 * again; for a saved server the new values stand, because settings already point at them.
 */
async function storeSecrets(serverId: string, items: EnvChange['toSave'], undoOnRefusal: boolean): Promise<string | undefined> {
  const done: string[] = []
  for (const { name, value } of items) {
    const result = await api.saveMcpSecret({ serverId, name, value })
      .catch((reason: unknown) => ({ ok: false as const, message: reason instanceof Error ? reason.message : String(reason) }))
    if (!result.ok) {
      if (undoOnRefusal && done.length > 0) void api.forgetMcpSecrets({ serverId, names: done }).catch(() => undefined)
      return `The secret ${name} was not saved. ${result.message}`
    }
    done.push(name)
  }
  return undefined
}

/** The server with its variables replaced by what was edited. */
function withVariables(server: McpServerConfig, change: Pick<EnvChange, 'env' | 'secretEnv'>): McpServerConfig {
  const next: McpServerConfig = { ...server }
  delete next.env
  delete next.secretEnv
  if (change.env) next.env = change.env
  if (change.secretEnv) next.secretEnv = change.secretEnv
  return next
}

// --- A saved server ---------------------------------------------------------------

function Status({ server, status, checking, unknown, toolsOpen, toolsId, onToggleTools }: {
  server: McpServerConfig
  status: McpServerStatus | undefined
  checking: boolean
  /** The status read failed, so a missing status means "not known", not "not started". */
  unknown: boolean
  toolsOpen: boolean
  toolsId: string
  onToggleTools: () => void
}): JSX.Element | null {
  if (!server.enabled) {
    return <div className="prow__status">Off. Turn it on to let sessions use its tools.</div>
  }
  if (!status) {
    if (checking) return <div className="prow__status" role="status"><StateIcon state="working" size={14} />Checking</div>
    return <div className="prow__status">{unknown ? 'Status unknown' : 'Not started'}</div>
  }
  const lastTest = status.lastTest
  switch (status.state) {
    case 'connected':
      return (
        <div className="prow__status">
          <Check className="ok" size={14} aria-hidden="true" />
          <span>Connected, {plural(status.toolCount, 'tool')}</span>
          {status.toolCount > 0 && <Disclosure label={toolsOpen ? 'Hide tools' : 'Show tools'} open={toolsOpen} onToggle={onToggleTools} controls={toolsId} />}
        </div>
      )
    case 'failed':
      return (
        <>
          <div className="prow__status">
            <TriangleAlert className="bad" size={14} aria-hidden="true" />
            <span className="prow__why"><Prose text={status.error ?? 'The server stopped.'} /></span>
          </div>
          {status.hint && <div className="prow__fix"><Prose text={status.hint} /></div>}
          {status.output && <Output text={status.output} />}
        </>
      )
    default:
      return (
        <div className="prow__status">
          <span>Not started</span>
          <span>Starts the first time a session uses it.</span>
          {lastTest && <span>Last test {lastTest.ok ? `passed, ${plural(lastTest.toolCount, 'tool')}` : 'failed'}, {relativeTime(lastTest.at)}.</span>}
        </div>
      )
  }
}

/** The editor under a saved server: its variables as rows, changed only when saved. */
function ServerEnv({ server, missing, baseId, onSave, onClose }: {
  server: McpServerConfig
  /** Secrets of this server whose stored value is gone. */
  missing: readonly string[]
  baseId: string
  onSave: (change: EnvChange) => Promise<void>
  onClose: () => void
}): JSX.Element {
  const [drafts, setDrafts] = useState<EnvDraft[]>(() => draftsFromServer(server, missing))
  const [attempted, setAttempted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const stored = Object.keys(server.secretEnv ?? {})
  const check = checkDrafts(drafts, attempted)
  const plan = planEnvChange(drafts, stored, server.id)
  const changed = plan.toSave.length > 0 || plan.toForget.length > 0 || !sameVariables(plan.env, server.env) || !sameVariables(plan.secretEnv, server.secretEnv)

  const save = async (): Promise<void> => {
    setAttempted(true)
    if (busy || !checkDrafts(drafts, true).ok) return
    setBusy(true)
    setProblem(undefined)
    const refused = await storeSecrets(server.id, plan.toSave, false)
    if (refused) {
      setProblem(refused)
      setBusy(false)
      return
    }
    try {
      await onSave(plan)
    } catch (reason) {
      setProblem(`The changes were not saved. ${reason instanceof Error ? reason.message : String(reason)}`)
      setBusy(false)
      return
    }
    if (plan.toForget.length > 0) void api.forgetMcpSecrets({ serverId: server.id, names: plan.toForget }).catch(() => undefined)
    setBusy(false)
    onClose()
  }

  return (
    <div className="prow__editor" id={baseId}>
      <EnvHelp id={`${baseId}-help`} />
      <EnvEditor drafts={drafts} onChange={setDrafts} check={check} idBase={`${baseId}-rows`} disabled={busy} />
      {problem && <div className="pol-field-error" role="alert">{problem}</div>}
      <div className="pform__actions">
        <button type="button" className="btn btn--primary btn--sm" onClick={() => void save()} disabled={busy || !changed}>
          {busy ? <><StateIcon state="working" size={14} />Saving</> : 'Save changes'}
        </button>
        <button type="button" className="btn btn--sm btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
      </div>
    </div>
  )
}

function ServerRow({ server, status, checking, unknown, onToggle, onRemove, onSaveEnv }: {
  server: McpServerConfig
  status: McpServerStatus | undefined
  checking: boolean
  unknown: boolean
  onToggle: () => void
  onRemove: () => void
  onSaveEnv: (change: EnvChange) => Promise<void>
}): JSX.Element {
  const { test, run, clear } = useConnectionTest()
  const [toolsOpen, setToolsOpen] = useState(false)
  const [envOpen, setEnvOpen] = useState(false)
  const toolsId = useId()
  const envId = useId()
  const line = commandLine(server.command, server.args)
  const testing = test.phase === 'testing'
  const variables = Object.keys(server.env ?? {}).length + Object.keys(server.secretEnv ?? {}).length
  return (
    <li className="prow" aria-busy={testing}>
      <div className="prow__head">
        <button
          type="button"
          className={`switch ${server.enabled ? 'switch--on' : ''}`}
          onClick={onToggle}
          role="switch"
          aria-checked={server.enabled}
          aria-label={`Enable ${server.name}`}
          title={server.enabled ? 'On' : 'Off'}
        />
        <div className="prow__title">
          <div className="prow__name">{server.name}</div>
          <div className="prow__cmd" title={line}>{line}</div>
        </div>
        <div className="prow__actions">
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => run({ id: server.id, name: server.name, command: server.command, args: server.args ?? [], ...savedVariables(server) })}
            disabled={testing}
          >
            {testing ? <><StateIcon state="working" size={14} />Testing</> : 'Test connection'}
          </button>
          <ArmedRemove subject={`the ${server.name} server`} noun="server" onConfirm={onRemove} />
        </div>
      </div>
      <div className="prow__below">
        <Status server={server} status={status} checking={checking} unknown={unknown} toolsOpen={toolsOpen} toolsId={toolsId} onToggleTools={() => setToolsOpen(!toolsOpen)} />
        {toolsOpen && status?.state === 'connected' && <ToolList id={toolsId} tools={status.tools} total={status.toolCount} />}
        <div className="prow__env">
          <Disclosure label={variables > 0 ? `Environment variables, ${variables}` : 'Environment variables'} open={envOpen} onToggle={() => setEnvOpen(!envOpen)} controls={envId} />
        </div>
        {envOpen && (
          <ServerEnv server={server} missing={status?.missingSecrets ?? []} baseId={envId} onSave={onSaveEnv} onClose={() => setEnvOpen(false)} />
        )}
        {test.phase === 'done' && test.result && <TestResult result={test.result} onHide={clear} />}
      </div>
    </li>
  )
}

// --- The add form -----------------------------------------------------------------

function AddServer({ onAdd }: { onAdd: (server: McpServerConfig) => void }): JSX.Element {
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [drafts, setDrafts] = useState<EnvDraft[]>([])
  const [attempted, setAttempted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const { test, run, clear } = useConnectionTest()
  const parsed = useMemo(() => parseMcpArguments(args), [args])
  const id = useId()
  const envCheck = checkDrafts(drafts, attempted)
  const complete = !!name.trim() && !!command.trim() && parsed.ok && envCheck.ok
  const testing = test.phase === 'testing'

  const add = async (): Promise<void> => {
    setAttempted(true)
    if (busy || !complete || !parsed.ok || !checkDrafts(drafts, true).ok) return
    const serverId = crypto.randomUUID()
    const plan = planEnvChange(drafts, [], serverId)
    setBusy(true)
    setProblem(undefined)
    const refused = await storeSecrets(serverId, plan.toSave, true)
    if (refused) {
      setProblem(refused)
      setBusy(false)
      return
    }
    onAdd(withVariables({ id: serverId, name: name.trim(), command: command.trim(), args: parsed.args, enabled: true }, plan))
    setName('')
    setCommand('')
    setArgs('')
    setDrafts([])
    setAttempted(false)
    setBusy(false)
    clear()
  }
  const check = (): void => {
    setAttempted(true)
    if (!command.trim() || !parsed.ok || !checkDrafts(drafts, true).ok) return
    run({ name: name.trim() || 'New server', command: command.trim(), args: parsed.args, ...testVariables(drafts) })
  }

  return (
    <form className="pform" onSubmit={(event) => { event.preventDefault(); void add() }}>
      <h3 className="pform__title">Add a server</h3>
      <div className="pform__grid">
        <label className="pform__field" htmlFor={`${id}-name`}>
          <span>Name</span>
          <input id={`${id}-name`} className="input" placeholder="Filesystem" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
        </label>
        <label className="pform__field" htmlFor={`${id}-command`}>
          <span>Command</span>
          <input id={`${id}-command`} className="input mono" placeholder="npx" value={command} onChange={(e) => setCommand(e.target.value)} spellCheck={false} />
        </label>
        <div className="pform__field pform__field--wide">
          <label htmlFor={`${id}-args`}>Arguments</label>
          <textarea
            id={`${id}-args`}
            className="input mono"
            placeholder={'["-y", "@modelcontextprotocol/server-filesystem", "."]'}
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            aria-describedby={`${id}-args-help${parsed.ok ? '' : ` ${id}-args-error`}`}
            aria-invalid={!parsed.ok}
            spellCheck={false}
            rows={3}
          />
          <div id={`${id}-args-help`} className="pform__help">
            JSON array of strings. Leave blank for no arguments. Keep paths with spaces in one string;
            double Windows backslashes, for example <code className="pol-code">{'["C:\\\\My Project"]'}</code>.
          </div>
          {!parsed.ok && <div id={`${id}-args-error`} className="pol-field-error" role="alert">{parsed.error}</div>}
        </div>
        <fieldset className="pform__field pform__field--wide env-set" aria-describedby={`${id}-env-help`}>
          <legend>Environment variables</legend>
          <EnvHelp id={`${id}-env-help`} />
          <EnvEditor drafts={drafts} onChange={setDrafts} check={envCheck} idBase={`${id}-env`} disabled={busy} />
          {problem && <div className="pol-field-error" role="alert">{problem}</div>}
        </fieldset>
      </div>
      <div className="pform__actions">
        <button type="button" className="btn" onClick={check} disabled={testing || busy || !command.trim() || !parsed.ok || !envCheck.ok}>
          {testing ? <><StateIcon state="working" size={14} />Testing</> : 'Test connection'}
        </button>
        <button type="submit" className="btn btn--primary" disabled={!complete || busy}>Add server</button>
      </div>
      {test.phase === 'done' && test.result && <TestResult result={test.result} onHide={clear} />}
    </form>
  )
}

// --- The group --------------------------------------------------------------------

function McpSection(): JSX.Element {
  const servers = useStore((s) => s.settings?.mcpServers) ?? []
  const save = useStore((s) => s.saveSettings)
  const signature = useMemo(() => JSON.stringify(servers.map((s) => [s.id, s.enabled, s.command, s.args ?? [], s.env ?? {}, s.secretEnv ?? {}])), [servers])
  const status = useMcpStatus(signature)

  const update = (id: string, patch: Partial<McpServerConfig>): void =>
    void save({ mcpServers: servers.map((s) => (s.id === id ? { ...s, ...patch } : s)) })
  const remove = (server: McpServerConfig): void => {
    void save({ mcpServers: servers.filter((s) => s.id !== server.id) })
    const names = Object.keys(server.secretEnv ?? {})
    if (names.length > 0) void api.forgetMcpSecrets({ serverId: server.id, names }).catch(() => undefined)
  }

  return (
    <div>
      <p className="setgroup__note">
        Connect Model Context Protocol servers that run on this PC. The model sees their tools as
        <span className="mono"> mcp__server__tool</span>, and each call asks for your permission unless you saved a rule for it.
      </p>
      {status.error && <LoadError title="Server status could not be read" message={status.error} onRetry={status.reload} />}
      {servers.length === 0
        ? (
          <Empty title="No MCP servers yet">
            A server adds tools the model can call, such as reading a database or a team wiki. Add one below,
            then test the connection to see the tools it offers.
          </Empty>
        )
        : (
          <ul className="prows">
            {servers.map((server) => (
              <ServerRow
                key={server.id}
                server={server}
                status={status.byId.get(server.id)}
                checking={status.loading}
                unknown={!!status.error}
                onToggle={() => update(server.id, { enabled: !server.enabled })}
                onRemove={() => remove(server)}
                onSaveEnv={(change) => save({ mcpServers: servers.map((s) => (s.id === server.id ? withVariables(s, change) : s)) })}
              />
            ))}
          </ul>
        )}
      <AddServer onAdd={(server) => void save({ mcpServers: [...servers, server] })} />
    </div>
  )
}

export const section: SettingsSection = { id: 'mcp', title: 'MCP servers', page: 'tools', order: 310, Component: McpSection }
