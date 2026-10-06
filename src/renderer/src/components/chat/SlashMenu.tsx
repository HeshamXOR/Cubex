import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { BookOpen, SquareSlash } from 'lucide-react'
import type { SkillSummary } from '../../../../shared/ipc'
import { SKILL_SOURCE_LABEL } from '../../../../shared/skillInvocation'
import { matchSlash, slashKeyAction, slashQuery, type SlashEntry, type SlashMatches } from '../../lib/slashCommands'
import './slashmenu.css'

const NO_SKILLS: readonly SkillSummary[] = []
const NO_MATCHES: SlashMatches = { commands: [], skills: [] }
/** Descriptions can run to a thousand characters; a row shows one line, and the full text is on the row's tooltip. */
const DESCRIPTION_SHOWN = 220

export interface SlashMenuState {
  open: boolean
  commands: SlashEntry[]
  skills: SlashEntry[]
  /** Index into commands followed by skills. */
  active: number
  listboxId: string
  /** The id of the highlighted row, for the text field's `aria-activedescendant`; absent while the menu is closed. */
  activeId: string | undefined
  /** What the skills group says when it has no rows: that they are being read, or where to put some. */
  skillsNote: 'loading' | 'empty' | undefined
  listRef: RefObject<HTMLDivElement>
  /** True when the key was the menu's, and has been handled. */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean
  pick: (entry: SlashEntry) => void
  hover: (index: number) => void
  onFocus: () => void
  onBlur: () => void
}

/**
 * The state of the "/" menu over the composer's text field. The menu is open while the draft is a slash and one
 * word, the field has focus, and something matches. Focus never leaves the field: the highlighted row is announced
 * through `aria-activedescendant` and the arrow keys, Enter, Tab and Esc come through `onKeyDown`.
 */
export function useSlashMenu(args: {
  text: string
  setText: (value: string) => void
  /** Undefined until the first list arrives. */
  skills: readonly SkillSummary[] | undefined
  loading: boolean
  focusField: () => void
}): SlashMenuState {
  const { text, setText, skills, loading, focusField } = args
  const listboxId = useId()
  const listRef = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState(false)
  // The highlight belongs to what was typed: a different word starts again at the top.
  const [cursor, setCursor] = useState({ query: '', index: 0 })
  const [dismissedFor, setDismissedFor] = useState<string>()

  const query = slashQuery(text)
  const matches = useMemo(() => (query === undefined ? NO_MATCHES : matchSlash(query, skills ?? NO_SKILLS)), [query, skills])
  const entries = useMemo(() => [...matches.commands, ...matches.skills], [matches])
  const open = focused && query !== undefined && dismissedFor !== text && entries.length > 0
  const active = cursor.query === query ? Math.min(cursor.index, entries.length - 1) : 0
  const skillsNote = matches.skills.length > 0 ? undefined
    : skills === undefined ? (loading ? 'loading' : undefined)
      : skills.length === 0 && query === '' ? 'empty' : undefined

  useEffect(() => {
    if (open) listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [open, active, entries])

  const pick = (entry: SlashEntry): void => {
    setText(`/${entry.token} `)
    focusField()
  }

  return {
    open,
    commands: matches.commands,
    skills: matches.skills,
    active,
    listboxId,
    activeId: open ? `${listboxId}-${active}` : undefined,
    skillsNote,
    listRef,
    onKeyDown: (event) => {
      if (!open || event.nativeEvent.isComposing) return false
      const action = slashKeyAction(event, { entries, active, draft: text })
      if (!action) return false
      event.preventDefault()
      if (action.type === 'move') setCursor({ query: query ?? '', index: action.to })
      else if (action.type === 'pick') pick(action.entry)
      else setDismissedFor(text)
      return true
    },
    pick,
    hover: (index) => { if (index !== active) setCursor({ query: query ?? '', index }) },
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false)
  }
}

function shortened(text: string): string {
  return text.length > DESCRIPTION_SHOWN ? `${text.slice(0, DESCRIPTION_SHOWN).trimEnd()}…` : text
}

function Row({ entry, index, menu }: { entry: SlashEntry; index: number; menu: SlashMenuState }): JSX.Element {
  const description = entry.kind === 'command' ? entry.command.description : entry.skill.description
  return (
    <div
      id={`${menu.listboxId}-${index}`}
      className="slashmenu__row"
      role="option"
      aria-selected={index === menu.active}
      title={entry.kind === 'skill' ? description : undefined}
      // The field keeps focus while a row is clicked, so the caret stays where the person is typing.
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={() => menu.hover(index)}
      onClick={() => menu.pick(entry)}
    >
      <span className="slashmenu__name">
        <span className="slashmenu__slash">/</span>{entry.token}
        {entry.kind === 'command' && entry.command.args ? <span className="slashmenu__args"> {entry.command.args}</span> : null}
      </span>
      <span className="slashmenu__desc">{shortened(description)}</span>
      {entry.kind === 'skill' ? <span className="slashmenu__source">{SKILL_SOURCE_LABEL[entry.skill.source]}</span> : null}
    </div>
  )
}

/** The commands, then the skills the task can use, as one listbox above the composer. */
export function SlashMenu({ menu }: { menu: SlashMenuState }): JSX.Element {
  const commandsId = `${menu.listboxId}-commands`
  const skillsId = `${menu.listboxId}-skills`
  const showSkills = menu.skills.length > 0 || menu.skillsNote !== undefined
  return (
    <div className="slashmenu">
      <div ref={menu.listRef} id={menu.listboxId} className="slashmenu__list" role="listbox" aria-label="Commands and skills">
        {menu.commands.length > 0 && (
          <div className="slashmenu__group" role="group" aria-labelledby={commandsId}>
            <div className="slashmenu__label" id={commandsId}><SquareSlash size={13} aria-hidden="true" />Commands</div>
            {menu.commands.map((entry, index) => <Row key={entry.token} entry={entry} index={index} menu={menu} />)}
          </div>
        )}
        {showSkills && (
          <div className="slashmenu__group" role="group" aria-labelledby={skillsId}>
            <div className="slashmenu__label" id={skillsId}><BookOpen size={13} aria-hidden="true" />Skills</div>
            {menu.skills.map((entry, index) => <Row key={entry.token} entry={entry} index={menu.commands.length + index} menu={menu} />)}
            {menu.skillsNote === 'loading' && <div className="slashmenu__note">Loading skills</div>}
            {menu.skillsNote === 'empty' && <div className="slashmenu__note">Skills appear here. Add one at .cubex/skills/name/SKILL.md in your project.</div>}
          </div>
        )}
      </div>
    </div>
  )
}
