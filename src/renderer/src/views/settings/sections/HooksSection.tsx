import { useId, useMemo, useRef, useState } from 'react'
import { Check, TriangleAlert } from 'lucide-react'
import type { HookConfig } from '../../../../../shared/settings'
import {
  COMMON_HOOK_TOOLS, HOOK_EVENTS, HOOK_EVENT_INFO, HOOK_LIMITS, hookMatches, matcherProblem, matcherTerms,
  type HookEvent, type HookTestRequest, type HookTestResult
} from '../../../../../shared/policy'
import { api } from '../../../lib/api'
import { describeHookTrigger, explainHookTest, folderLabel, type TextPart } from '../../../lib/hookText'
import { useStore } from '../../../state/store'
import { StateIcon } from '../../../status/StatusIndicator'
import { ArmedRemove, Disclosure, Empty, LoadError, took } from '../policyUi'
import type { SettingsSection } from '../registry'

// --- Tests ------------------------------------------------------------------------

interface TestState {
  phase: 'idle' | 'testing' | 'done'
  result?: HookTestResult
  /** The test could not run at all, as opposed to a hook that failed. */
  error?: string
}

/** One test at a time per row or form; a newer one replaces an older one still running. */
function useHookTest(): { test: TestState; run: (request: HookTestRequest) => void; clear: () => void } {
  const [test, setTest] = useState<TestState>({ phase: 'idle' })
  const latest = useRef(0)
  const run = (request: HookTestRequest): void => {
    const mine = ++latest.current
    setTest({ phase: 'testing' })
    api.testHook(request).then(
      (result) => { if (latest.current === mine) setTest({ phase: 'done', result }) },
      (reason: unknown) => { if (latest.current === mine) setTest({ phase: 'done', error: reason instanceof Error ? reason.message : String(reason) }) }
    )
  }
  const clear = (): void => {
    latest.current++
    setTest({ phase: 'idle' })
  }
  return { test, run, clear }
}

function Parts({ parts }: { parts: readonly TextPart[] }): JSX.Element {
  return <>{parts.map((part, index) => (part.code ? <code key={index} className="pol-code">{part.text}</code> : part.text))}</>
}

function Stream({ label, text }: { label: string; text: string }): JSX.Element {
  return (
    <>
      <div className="callout__hint">{label}</div>
      <pre className="pol-pre" tabIndex={0} aria-label={label}>{text}</pre>
    </>
  )
}

/** What a hook did when it ran: the verdict first, then where it ran and what it printed. */
function TestOutcome({ test, onHide, onRetry }: { test: TestState; onHide: () => void; onRetry: () => void }): JSX.Element | null {
  const [showInput, setShowInput] = useState(false)
  const inputId = useId()
  if (test.error) return <LoadError title="The test could not run" message={test.error} onRetry={onRetry} />
  const result = test.result
  if (!result) return null
  const verdict = explainHookTest(result)
  const Icon = verdict.tone === 'ok' ? Check : TriangleAlert
  return (
    <div className={`callout ${verdict.tone === 'ok' ? 'callout--ok' : verdict.tone === 'warn' ? 'callout--warn' : 'callout--error'} pol-callout`} role="status">
      <Icon size={14} aria-hidden="true" />
      <div className="callout__body">
        <strong>{verdict.title}</strong>
        <div>{verdict.body}</div>
        {result.reason && <div className="callout__hint">It said: {result.reason}</div>}
        <dl className="pol-meta">
          <div><dt>Exit code</dt><dd>{result.exitCode ?? 'none'}</dd></div>
          <div><dt>Took</dt><dd>{took(result.durationMs)}</dd></div>
          <div><dt>{folderLabel(result)}</dt><dd className="mono" title={result.cwd}>{result.cwd}</dd></div>
        </dl>
        {result.stdout && <Stream label="Output" text={result.stdout} />}
        {result.stderr && <Stream label="Error output" text={result.stderr} />}
        {result.truncated && <div className="callout__hint">Long output was cut short.</div>}
        <Disclosure label="Input the hook received" open={showInput} onToggle={() => setShowInput(!showInput)} controls={inputId} />
        {showInput && <pre className="pol-pre" id={inputId} tabIndex={0} aria-label="Input the hook received">{result.payload}</pre>}
      </div>
      <div className="callout__actions">
        <button type="button" className="callout__action" onClick={onHide}>Hide</button>
      </div>
    </div>
  )
}

// --- A saved hook -----------------------------------------------------------------

function HookRow({ hook, onToggle, onRemove }: { hook: HookConfig; onToggle: () => void; onRemove: () => void }): JSX.Element {
  const { test, run, clear } = useHookTest()
  const testing = test.phase === 'testing'
  const start = (): void => run({ event: hook.event, ...(hook.matcher ? { matcher: hook.matcher } : {}), command: hook.command })
  return (
    <li className="prow" aria-busy={testing}>
      <div className="prow__head">
        <button
          type="button"
          className={`switch ${hook.enabled ? 'switch--on' : ''}`}
          onClick={onToggle}
          aria-pressed={hook.enabled}
          aria-label={`${hook.enabled ? 'Disable' : 'Enable'} the ${hook.event} hook`}
          title={hook.enabled ? 'On' : 'Off'}
        />
        <div className="prow__title">
          <div className="prow__name">
            {hook.event}
            <span className="prow__sub"><Parts parts={describeHookTrigger(hook.event, hook.matcher)} /></span>
          </div>
          <div className="prow__cmd" title={hook.command}>{hook.command}</div>
        </div>
        <div className="prow__actions">
          <button
            type="button"
            className="btn btn--sm"
            onClick={start}
            disabled={testing}
            title="Runs the command once, for real, with sample input"
          >
            {testing ? <><StateIcon state="working" size={14} />Running</> : 'Run a test'}
          </button>
          <ArmedRemove subject={`the ${hook.event} hook`} noun="hook" onConfirm={onRemove} />
        </div>
      </div>
      {(!hook.enabled || test.phase === 'done') && (
        <div className="prow__below">
          {!hook.enabled && <div className="prow__status">Off. Sessions skip it until you turn it on; a test still runs it.</div>}
          {test.phase === 'done' && <TestOutcome test={test} onHide={clear} onRetry={start} />}
        </div>
      )}
    </li>
  )
}

// --- The add form -----------------------------------------------------------------

function AddHook({ onAdd }: { onAdd: (hook: HookConfig) => void }): JSX.Element {
  const [event, setEvent] = useState<HookEvent>('PreToolUse')
  const [matcher, setMatcher] = useState('')
  const [command, setCommand] = useState('')
  const { test, run, clear } = useHookTest()
  const id = useId()
  const info = HOOK_EVENT_INFO[event]
  const problem = info.matchesTools ? matcherProblem(matcher) : undefined
  const tooLong = command.length > HOOK_LIMITS.command
  const complete = !!command.trim() && !problem && !tooLong
  const testing = test.phase === 'testing'
  const effectiveMatcher = info.matchesTools ? matcher.trim() : ''

  // What the text would match among the tools people most often aim hooks at.
  const matches = useMemo(
    () => (matcherTerms(effectiveMatcher).length > 0 && !problem ? COMMON_HOOK_TOOLS.filter((tool) => hookMatches(effectiveMatcher, tool)) : []),
    [effectiveMatcher, problem]
  )

  const request = (): HookTestRequest => ({ event, ...(effectiveMatcher ? { matcher: effectiveMatcher } : {}), command: command.trim() })
  const add = (): void => {
    if (!complete) return
    onAdd({ id: crypto.randomUUID(), event, ...(effectiveMatcher ? { matcher: effectiveMatcher } : {}), command: command.trim(), enabled: true })
    setMatcher('')
    setCommand('')
    clear()
  }

  return (
    <form className="pform" onSubmit={(e) => { e.preventDefault(); add() }}>
      <h3 className="pform__title">Add a hook</h3>
      <div className="pform__grid">
        <div className="pform__field pform__select">
          <label htmlFor={`${id}-event`}>Event</label>
          <select id={`${id}-event`} className="select" value={event} onChange={(e) => setEvent(e.target.value as HookEvent)} aria-describedby={`${id}-event-help`}>
            {HOOK_EVENTS.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <div className="pform__help" id={`${id}-event-help`}>{info.when}</div>
        </div>
        <div className="pform__field">
          <label htmlFor={`${id}-matcher`}>Tool to match</label>
          <input
            id={`${id}-matcher`}
            className="input mono"
            placeholder={info.matchesTools ? 'write_file|edit_file (optional)' : 'Not used by this event'}
            value={info.matchesTools ? matcher : ''}
            onChange={(e) => setMatcher(e.target.value)}
            disabled={!info.matchesTools}
            aria-invalid={!!problem}
            aria-describedby={`${id}-matcher-help`}
            spellCheck={false}
          />
          <div className="pform__help" id={`${id}-matcher-help`}>
            {!info.matchesTools
              ? `${event} hooks run once per ${event === 'Stop' ? 'turn' : 'message'}, so there is no tool to match.`
              : problem
                ? <span className="pol-field-error" role="alert">{problem}</span>
                : matches.length > 0
                  ? <>Matches {matches.map((tool, index) => <span key={tool}>{index > 0 && ', '}<code className="pol-code">{tool}</code></span>)}.</>
                  : matcherTerms(effectiveMatcher).length > 0
                    ? 'No built-in tool matches that text. MCP tools match by their full name, such as mcp__github__create_issue.'
                    : 'Runs for every tool. To narrow it, type part of a tool name such as write_file. Separate several with |.'}
          </div>
        </div>
        <div className="pform__field pform__field--wide">
          <label htmlFor={`${id}-command`}>Command</label>
          <input
            id={`${id}-command`}
            className="input mono"
            placeholder="npm run format"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            aria-invalid={tooLong}
            aria-describedby={`${id}-command-help`}
            spellCheck={false}
          />
          <div className={tooLong ? 'pol-field-error' : 'pform__help'} id={`${id}-command-help`} role={tooLong ? 'alert' : undefined}>
            {tooLong
              ? `The command must be ${HOOK_LIMITS.command.toLocaleString('en-US')} characters or fewer.`
              : 'Runs in a shell, in the project folder. The event arrives as JSON on stdin.'}
          </div>
        </div>
      </div>
      <div className="pform__actions">
        <button
          type="button"
          className="btn"
          onClick={() => run(request())}
          disabled={testing || !complete}
          title="Runs the command once, for real, with sample input"
        >
          {testing ? <><StateIcon state="working" size={14} />Running</> : 'Run a test'}
        </button>
        <button type="submit" className="btn btn--primary" disabled={!complete}>Add hook</button>
      </div>
      {test.phase === 'done' && <TestOutcome test={test} onHide={clear} onRetry={() => run(request())} />}
    </form>
  )
}

// --- The group --------------------------------------------------------------------

function HooksSection(): JSX.Element {
  const hooks = useStore((s) => s.settings?.hooks) ?? []
  const save = useStore((s) => s.saveSettings)
  const update = (id: string, patch: Partial<HookConfig>): void =>
    void save({ hooks: hooks.map((h) => (h.id === id ? { ...h, ...patch } : h)) })

  return (
    <div>
      <p className="setgroup__note">
        Run a shell command when something happens in a session. The command receives the event as JSON on stdin.
        A <code className="pol-code">PreToolUse</code> hook that exits with code <code className="pol-code">2</code>, or prints{' '}
        <code className="pol-code">{'{"decision":"block"}'}</code>, stops the tool before it runs; the other events cannot stop anything.
        Run a test starts the command once, for real, in your project folder with sample input.
      </p>
      {hooks.length === 0
        ? (
          <Empty title="No hooks yet">
            A hook can guard the tools the model uses, for example refusing writes to a protected folder, or tidy up
            after it, for example formatting every file it edits. Add one below and try it with a test run.
          </Empty>
        )
        : (
          <ul className="prows">
            {hooks.map((hook) => (
              <HookRow
                key={hook.id}
                hook={hook}
                onToggle={() => update(hook.id, { enabled: !hook.enabled })}
                onRemove={() => void save({ hooks: hooks.filter((h) => h.id !== hook.id) })}
              />
            ))}
          </ul>
        )}
      <AddHook onAdd={(hook) => void save({ hooks: [...hooks, hook] })} />
    </div>
  )
}

export const section: SettingsSection = { id: 'hooks', title: 'Hooks', order: 320, Component: HooksSection }
