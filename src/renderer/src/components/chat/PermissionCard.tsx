import { useEffect, useMemo, useRef } from 'react'
import { ShieldQuestion } from 'lucide-react'
import type { PermissionAsk, PermissionDecision } from '../../../../shared/ipc'
import { toolTarget } from '../../lib/transcriptGroups'
import { basename } from '../../lib/format'

/** A key that arrives sooner than this after the card appears is more likely a leftover keystroke than a decision. */
const KEY_GRACE_MS = 450

interface AskView {
  heading: string
  /** The command to run, for shell calls. */
  command?: string
  /** A short line naming what the call touches: a path, a host, a tool. */
  target?: string
  /** Proposed lines for edits: '+' added, '-' removed, ' ' neutral. */
  preview?: Array<{ tag: '+' | '-' | ' '; text: string }>
  /** Anything else worth reading, as plain text. */
  body?: string
}

const PREVIEW_LINES = 12

function lines(text: string, tag: '+' | '-', limit = PREVIEW_LINES): Array<{ tag: '+' | '-' | ' '; text: string }> {
  const all = text.split('\n')
  const shown: Array<{ tag: '+' | '-' | ' '; text: string }> = all.slice(0, limit).map((line) => ({ tag, text: line }))
  if (all.length > limit) shown.push({ tag: ' ', text: `… ${all.length - limit} more lines` })
  return shown
}

function parseInput(detail: string | undefined): Record<string, unknown> | undefined {
  if (!detail) return undefined
  try {
    const parsed: unknown = JSON.parse(detail)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** The heading and the readable parts of a permission request, from the facts the main process sends. */
export function describeAsk(ask: PermissionAsk): AskView {
  const target = toolTarget({ name: ask.toolName, title: ask.title })
  const input = parseInput(ask.detail)
  switch (ask.toolName) {
    case 'run_command': {
      const match = /^\$ ([\s\S]*?)(?:\n\(timeout (\d+) ms\))?$/.exec(ask.detail ?? '')
      return { heading: 'Run this command?', command: match?.[1] ?? target, body: match?.[2] ? `Stops after ${Number(match[2]) / 1000} seconds.` : undefined }
    }
    case 'write_file': {
      const content = typeof input?.content === 'string' ? input.content : undefined
      return { heading: 'Write this file?', target, preview: content ? lines(content, '+') : undefined }
    }
    case 'edit_file': {
      const before = typeof input?.old_string === 'string' ? input.old_string : undefined
      const after = typeof input?.new_string === 'string' ? input.new_string : undefined
      return { heading: 'Edit this file?', target, preview: [...(before ? lines(before, '-', 8) : []), ...(after ? lines(after, '+', 8) : [])] }
    }
    case 'multi_edit':
      return { heading: 'Edit this file?', target }
    case 'apply_patch': {
      const patch = typeof input?.patch === 'string' ? input.patch : undefined
      const preview = patch?.split('\n').filter((line) => /^[+-](?![+-]{2})/.test(line)).slice(0, PREVIEW_LINES * 2).map((line) => ({ tag: line[0] as '+' | '-', text: line.slice(1) }))
      return { heading: 'Apply this patch?', target, preview }
    }
    case 'remove_file':
    case 'delete_file':
      return { heading: 'Delete this file?', target }
    case 'web_fetch':
      return { heading: 'Fetch this page?', target: typeof input?.url === 'string' ? input.url : target }
    case 'git_commit':
      return { heading: 'Commit these changes?', target, body: typeof input?.message === 'string' ? input.message : undefined }
    case 'git_branch':
      return { heading: 'Change the branch?', target }
    case 'delegate_to_subagent':
      return { heading: 'Start a subagent?', target }
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(ask.toolName)
      if (mcp) return { heading: `Use ${mcp[2]} from ${mcp[1]}?`, body: ask.detail }
      return { heading: `Allow ${ask.title || ask.toolName}?`, body: ask.detail }
    }
  }
}

export function PermissionCard({ ask, workspace, onDecide }: {
  ask: PermissionAsk
  workspace?: string
  onDecide: (decision: PermissionDecision) => void
}): JSX.Element {
  const view = useMemo(() => describeAsk(ask), [ask])
  const shownAt = useRef(performance.now())
  const decide = useRef(onDecide)
  decide.current = onDecide

  // The grace period belongs to this request, not to each render of it.
  useEffect(() => {
    shownAt.current = performance.now()
  }, [ask.id])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
      if (performance.now() - shownAt.current < KEY_GRACE_MS) return
      const target = event.target instanceof HTMLElement ? event.target : undefined
      if (event.key === 'Escape') {
        event.preventDefault()
        decide.current('deny')
        return
      }
      if (event.key !== 'Enter') return
      // Enter belongs to whatever has focus when that is a control or a draft being written.
      if (target?.closest('button, a, select, summary, [role="menuitem"]')) return
      if ((target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) && target.value.trim()) return
      event.preventDefault()
      decide.current('allow')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const place = workspace ? basename(workspace) : undefined
  const mayChange = ask.toolName === 'run_command'
  return (
    <section className="ask" role="alertdialog" aria-labelledby={`ask-${ask.id}`} aria-describedby={`ask-${ask.id}-why`}>
      <div className="ask-h">
        <ShieldQuestion size={16} aria-hidden="true" />
        <b id={`ask-${ask.id}`}>{view.heading}</b>
        {view.target && <span className="src" title={view.target}>{view.target}</span>}
      </div>
      {view.command !== undefined && <div className="ask-cmd"><span className="pr">$</span>{view.command}</div>}
      {view.preview && view.preview.length > 0 && (
        <div className="ask-diff" aria-label="Proposed change">
          {view.preview.map((line, index) => (
            <div key={index} className={`ask-dl ${line.tag === '+' ? 'add' : line.tag === '-' ? 'del' : ''}`}>
              <span className="sg" aria-hidden="true">{line.tag === ' ' ? '' : line.tag === '+' ? '+' : '−'}</span>
              <span>{line.text || ' '}</span>
            </div>
          ))}
        </div>
      )}
      {view.body && !view.command && <pre className="ask-body">{view.body}</pre>}
      {view.body && view.command !== undefined && <p className="ask-why">{view.body}</p>}
      {ask.risks?.map((risk) => <p className="ask-risk" key={risk}>{risk}</p>)}
      <p className="ask-why" id={`ask-${ask.id}-why`}>
        {place ? <>Runs in <b>{place}</b> with your permissions.</> : 'Runs with your permissions.'}
        {mayChange && " Rewind can't undo what a command changes."}
      </p>
      <div className="ask-f">
        <button className="btn pri" onClick={() => onDecide('allow')} autoFocus={false}>Allow once<kbd>Enter</kbd></button>
        {ask.rule && (
          <button className="btn" onClick={() => onDecide('always')} title={`Saved for this project. Manage rules in Settings.`}>
            Always allow <code>{ask.rule.label}</code>
          </button>
        )}
        <span className="grow" />
        <button className="btn ghost" onClick={() => onDecide('deny')}>Deny<kbd>Esc</kbd></button>
      </div>
    </section>
  )
}
