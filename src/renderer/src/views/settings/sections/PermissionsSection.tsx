import { useId, useMemo, useState } from 'react'
import { Bot, CircleSlash, FilePenLine, Globe, Plug, Terminal, type LucideIcon } from 'lucide-react'
import { relativeTime } from '../../../lib/api'
import { basename } from '../../../lib/format'
import { groupRulesByProject, RULE_COVERAGE, type ProjectRules, type RuleKind, type RuleRow, type RuleText } from '../../../lib/permissionRuleText'
import { usePermissionRules } from '../../../lib/usePermissionRules'
import { useStore } from '../../../state/store'
import { ArmedRemove, Disclosure, Empty, LoadError, Working } from '../policyUi'
import type { SettingsSection } from '../registry'

const ICONS: Record<RuleKind, LucideIcon> = {
  command: Terminal,
  edit: FilePenLine,
  fetch: Globe,
  mcp: Plug,
  subagent: Bot,
  unknown: CircleSlash
}

function Sentence({ text }: { text: RuleText }): JSX.Element {
  return <>{text.parts.map((part, index) => (part.code ? <code key={index} className="pol-code">{part.text}</code> : part.text))}</>
}

function RuleItem({ row, onRemove }: { row: RuleRow; onRemove: (ids: readonly string[]) => void }): JSX.Element {
  const Icon = ICONS[row.text.kind]
  return (
    <li className={`rule ${row.text.kind === 'unknown' ? 'rule--inert' : ''}`}>
      <Icon className="rule__icon" size={14} aria-hidden="true" />
      <div className="rule__text"><Sentence text={row.text} /></div>
      <span className="rule__when" title={new Date(row.createdAt).toLocaleString()}>Saved {relativeTime(row.createdAt)}</span>
      <span className="rule__action">
        <ArmedRemove subject={`the rule: ${row.text.text}`} noun="rule" onConfirm={() => onRemove(row.ids)} />
      </span>
      {row.text.detail && <div className="rule__detail">{row.text.detail}</div>}
    </li>
  )
}

function Project({ group, onRemove }: { group: ProjectRules; onRemove: (ids: readonly string[]) => void }): JSX.Element {
  const name = basename(group.workspace)
  return (
    <section className="rules__project" aria-label={`Rules for ${name}`}>
      <div className="rules__head">
        <h3 className="rules__name">{name}</h3>
        {group.current && <span className="rules__tag">This project</span>}
      </div>
      <div className="rules__path" title={group.workspace}>{group.workspace}</div>
      <ul className="rules__list">
        {group.rows.map((row) => <RuleItem key={row.key} row={row} onRemove={onRemove} />)}
      </ul>
    </section>
  )
}

/** What each kind of rule covers and still asks about, said once instead of under every line. */
function Coverage(): JSX.Element {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <>
      <Disclosure label="What a rule covers" open={open} onToggle={() => setOpen(!open)} controls={id} />
      {open && (
        <dl className="pol-coverage" id={id}>
          {RULE_COVERAGE.map((entry) => (
            <div key={entry.kind}><dt>{entry.label}</dt><dd>{entry.text}</dd></div>
          ))}
        </dl>
      )}
    </>
  )
}

function PermissionsSection(): JSX.Element {
  const workspace = useStore((s) => s.settings?.general.workspacePath) || undefined
  const { rules, currentIds, loading, error, reload, remove } = usePermissionRules(workspace)
  const [removeError, setRemoveError] = useState<string>()
  const groups = useMemo(() => groupRulesByProject(rules, currentIds), [rules, currentIds])

  const removeRows = (ids: readonly string[]): void => {
    setRemoveError(undefined)
    void remove(ids).then(setRemoveError)
  }

  return (
    <div>
      <p className="setgroup__note">
        Rules you saved with Always allow on an approval card. A rule lets one kind of call run without asking,
        in the project it was saved for. Anything without a rule asks every time.
      </p>
      <Coverage />
      {error && <LoadError title="Saved rules could not be loaded" message={error} onRetry={reload} />}
      {removeError && <LoadError title="The rule could not be removed" message={removeError} />}
      {loading
        ? <Working>Loading rules…</Working>
        : groups.length === 0
          ? !error && (
            <Empty title="No saved rules">
              No call is pre-approved. When an approval card offers Always allow, choosing it saves a rule here for
              that project, and you can remove it at any time.
            </Empty>
          )
          : groups.map((group) => <Project key={group.key} group={group} onRemove={removeRows} />)}
    </div>
  )
}

export const section: SettingsSection = { id: 'permissions', title: 'Permissions', page: 'permissions', order: 300, Component: PermissionsSection }
