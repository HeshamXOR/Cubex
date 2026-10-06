import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUpRight, BookOpen, RefreshCw, Search, X } from 'lucide-react'
import type { SkillDocument, SkillSummary } from '../../../shared/ipc'
import { api, isBrowserPreview } from '../lib/api'
import { Markdown } from './Markdown'
import './skills.css'

const SOURCE_LABELS: Record<SkillSummary['source'], string> = {
  bundled: 'Built in', cubex: '.cubex', agents: '.agents', claude: '.claude'
}

const errorMessage = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason)

/** Settings follows the selected workspace; a workspace change remounts this library. */
export function SkillsLibrary({ workspacePath }: { workspacePath?: string }): JSX.Element {
  const id = useId()
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<SkillSummary>()

  useEffect(() => {
    let disposed = false
    setLoading(true)
    setError('')
    void api.listSkills().then((result) => {
      if (disposed) return
      setSkills(result)
      setLoading(false)
    }).catch((reason: unknown) => {
      if (disposed) return
      setError(errorMessage(reason))
      setLoading(false)
    })
    return () => { disposed = true }
  }, [revision])

  const search = query.trim().toLocaleLowerCase()
  const matches = skills.filter((skill) =>
    `${skill.name} ${skill.description} ${SOURCE_LABELS[skill.source]}`.toLocaleLowerCase().includes(search)
  )
  const refresh = (): void => { setSelected(undefined); setRevision((value) => value + 1) }

  return (
    <section className="skills-library" aria-label="Skills library">
      <p className="skills-library__intro">
        Models see a short catalog and load full instructions only when the task calls for them.
        Skills guide the work; they do not add permissions.
      </p>
      <p className="skills-library__workspace" title={workspacePath}>
        {workspacePath ? <><span>Selected workspace</span><code>{workspacePath}</code></> : 'Choose a workspace to include project skills.'}
      </p>
      <div className="skills-library__toolbar">
        <label className="skills-library__search" htmlFor={`${id}-search`}>
          <Search size={15} aria-hidden="true" />
          <input id={`${id}-search`} type="search" placeholder="Search skills" aria-label="Search skills"
            value={query} onChange={(event) => setQuery(event.target.value)} disabled={isBrowserPreview} />
        </label>
        <span className="skills-library__count" role="status" aria-live="polite">
          {!loading && !error && !isBrowserPreview && (search ? `${matches.length} of ${skills.length}` : `${skills.length} skills`)}
        </span>
        <button type="button" className="btn skills-library__refresh" onClick={refresh} disabled={loading || isBrowserPreview}
          aria-label="Refresh skills" title="Discover changes to local skill files">
          <RefreshCw size={14} aria-hidden="true" />Refresh
        </button>
      </div>

      {isBrowserPreview ? <p className="skills-library__empty">Run the Electron app to discover skills and read their instructions.</p>
        : loading ? <p className="skills-library__empty" role="status">Loading skills…</p>
          : error ? <div className="skills-library__empty"><p role="alert">Could not load skills. {error}</p><button type="button" className="btn" onClick={refresh}>Try again</button></div>
            : matches.length === 0 ? <div className="skills-library__empty">
              <p>{search ? 'No skills match your search.' : 'No skills were found.'}</p>
              {search && <button type="button" className="btn btn--ghost" onClick={() => setQuery('')}>Clear search</button>}
            </div>
              : <ul className="skills-library__list">
                {matches.map((skill) => (
                  <li key={skill.name} className="skills-library__row" data-skill-name={skill.name}>
                    <div className="skills-library__info">
                      <div className="skills-library__heading"><h3>{skill.name}</h3><span className="skills-library__source">{SOURCE_LABELS[skill.source]}</span></div>
                      <p>{skill.description}</p>
                    </div>
                    <button type="button" className="skills-library__inspect" onClick={() => setSelected(skill)}
                      aria-label={`Read instructions for ${skill.name}`} aria-haspopup="dialog">
                      Read<ArrowUpRight size={14} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>}
      <p className="skills-library__help">
        Add project skills or override a built-in skill in <code>.cubex/skills/&lt;name&gt;/SKILL.md</code>, then refresh.
        Each file needs a name and description in its YAML frontmatter.
      </p>
      {selected && <SkillInspector key={selected.name} skill={selected} onClose={() => setSelected(undefined)} />}
    </section>
  )
}

/** Instruction files are read lazily and displayed as documents, never run. */
function SkillInspector({ skill, onClose }: { skill: SkillSummary; onClose: () => void }): JSX.Element {
  const id = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const [document, setDocument] = useState<SkillDocument>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const previous = window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null
    const node = dialog.current
    node?.showModal()
    return () => {
      node?.close()
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    let disposed = false
    setLoading(true)
    setError('')
    void api.readSkill(skill.name).then((result) => {
      if (disposed) return
      setDocument(result)
      setLoading(false)
    }).catch((reason: unknown) => {
      if (disposed) return
      setError(errorMessage(reason))
      setLoading(false)
    })
    return () => { disposed = true }
  }, [skill.name, revision])

  const shown = document ?? skill
  return createPortal(
    <dialog ref={dialog} className="skill-inspector" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
      onCancel={(event) => { event.preventDefault(); onClose() }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
      }}>
      <header className="skill-inspector__header">
        <BookOpen size={19} strokeWidth={1.6} aria-hidden="true" />
        <div className="skill-inspector__identity">
          <h2 id={`${id}-title`}>{shown.name}</h2>
          <p id={`${id}-description`}>{shown.source === 'bundled' ? 'Built-in skill instructions' : `Skill instructions from ${SOURCE_LABELS[shown.source]}`}</p>
        </div>
        <button type="button" className="skill-inspector__close" aria-label="Close skill instructions" onClick={onClose} autoFocus><X size={18} aria-hidden="true" /></button>
      </header>
      <div className="skill-inspector__path"><code>{shown.path}</code></div>
      {loading ? <div className="skill-inspector__empty" role="status">Loading instructions…</div>
        : error ? <div className="skill-inspector__empty"><p role="alert">{error}</p><button type="button" className="btn" onClick={() => setRevision((value) => value + 1)}>Try again</button></div>
          : <div className="skill-inspector__body" tabIndex={0} role="region" aria-label="Skill document">
            <Markdown text={document?.content ?? ''} />
          </div>}
      <footer className="skill-inspector__footer">Full instructions are loaded into model context when the skill is used.</footer>
    </dialog>, window.document.body
  )
}
