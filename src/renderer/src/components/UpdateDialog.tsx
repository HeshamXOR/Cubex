import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { useStepRunner, useUpdates } from '../state/updates'
import { installBlocker, nextStep, releaseDate } from '../lib/updateText'
import { Markdown } from './Markdown'
import { BusyConfirm, ProgressLine } from './UpdateParts'
import './update.css'

const FOCUSABLE = 'a[href], button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'

/** Keeps Tab inside the dialog: from the last control it goes to the first, and back. */
function keepFocusIn(event: KeyboardEvent, panel: HTMLElement | null): void {
  if (!panel) return
  const controls = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)]
  const first = controls[0]
  const last = controls[controls.length - 1]
  if (!first || !last) {
    event.preventDefault()
    panel.focus()
    return
  }
  const active = document.activeElement
  const outside = !panel.contains(active)
  if (event.shiftKey ? active === first || active === panel || outside : active === last || outside) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus()
  }
}

/**
 * What changed in the release on offer, with the steps to get it. It is a modal dialog: it holds the keyboard, Esc
 * closes it instead of stopping a turn behind it, and the focus goes back to where it was.
 */
export function UpdateDialog(): JSX.Element | null {
  const open = useUpdates((store) => store.dialogOpen)
  const state = useUpdates((store) => store.state)
  const problem = useUpdates((store) => store.problem)
  const busy = useUpdates((store) => store.busy)
  const pending = useUpdates((store) => store.pending)
  const closeDialog = useUpdates((store) => store.closeDialog)
  const dismiss = useUpdates((store) => store.dismiss)
  const skip = useUpdates((store) => store.skip)
  const cancelDownload = useUpdates((store) => store.cancelDownload)
  const openPage = useUpdates((store) => store.openPage)
  const run = useStepRunner()
  const panel = useRef<HTMLDivElement>(null)
  const { update } = state
  const showing = open && !!update

  // An update that is gone (a newer look found nothing) leaves nothing to show.
  useEffect(() => { if (open && !update) closeDialog() }, [open, update, closeDialog])

  useEffect(() => {
    if (!showing) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        useUpdates.getState().closeDialog()
      } else if (event.key === 'Tab') {
        keepFocusIn(event, panel.current)
      } else if (event.ctrlKey || event.metaKey) {
        // Shortcuts wait while the dialog is open; copying and selecting still work.
        event.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [showing])

  // The focus moves into the dialog, and back to where it was when the dialog closes.
  useEffect(() => {
    if (!showing) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel.current?.focus()
    return () => { if (previous && document.contains(previous)) previous.focus() }
  }, [showing])

  if (!showing || !update) return null

  const { info } = update
  const step = nextStep(state, update)
  const error = update.error ?? problem
  const blocker = update.stage === 'available' ? installBlocker(state, update) : undefined
  const date = releaseDate(info.publishedAt)
  const asking = busy !== undefined && update.stage === 'ready'
  const idleStage = update.stage === 'available' || update.stage === 'ready'
  const working = (step.kind === 'download' && pending === 'download') || (step.kind === 'restart' && pending === 'install')
  const hasStatus = !!blocker || !!error || update.stage !== 'available'

  return (
    <div className="updd" onClick={() => closeDialog()}>
      <div className="updd__panel" role="dialog" aria-modal="true" aria-labelledby="updd-title" tabIndex={-1} ref={panel} onClick={(event) => event.stopPropagation()}>
        <div className="updd__head">
          <div>
            <h2 id="updd-title">What&rsquo;s new in Cubex {info.version}</h2>
            <p className="updd__sub">
              You have {state.currentVersion}.{date ? ` Released ${date}.` : ''}
              {step.kind !== 'release' && <button type="button" className="upd__link" onClick={() => void openPage()}>View release</button>}
            </p>
          </div>
          <button type="button" className="ib" aria-label="Close" title="Close" onClick={closeDialog}><X size={15} /></button>
        </div>

        <div className="updd__notes prose" role="region" aria-label="Release notes" tabIndex={0}>
          {info.notes.trim() ? <Markdown text={info.notes} paths={false} /> : <p>This release has no notes.</p>}
          {info.notesCut && (
            <p className="updd__cut">
              These notes are cut here. <button type="button" className="upd__link" onClick={() => void openPage()}>Read the rest on the release page</button>
            </p>
          )}
        </div>

        {hasStatus && (
          <div className="updd__status">
            {blocker && <p className="updd__note">{blocker}</p>}
            {update.stage === 'downloading' && <ProgressLine update={update} label={`Download of Cubex ${info.version}`} />}
            {update.stage === 'ready' && !error && <p className="updd__note">Downloaded and checked. Restart Cubex to finish updating.</p>}
            {update.stage === 'installing' && <p className="updd__note">Restarting to update. Cubex opens again in a moment.</p>}
            {error && <p className="updd__error" role="alert">{error}</p>}
          </div>
        )}

        <div className="updd__foot">
          {asking ? <BusyConfirm /> : (
            <>
              {idleStage && <button type="button" className="btn ghost" disabled={pending === 'skip'} onClick={() => void skip()}>Skip this version</button>}
              {update.stage === 'downloading' && <button type="button" className="btn ghost" disabled={pending === 'cancel'} onClick={() => void cancelDownload()}>Cancel download</button>}
              <span className="grow" />
              {idleStage && <button type="button" className="btn ghost" onClick={dismiss}>Later</button>}
              {update.stage === 'downloading' && <button type="button" className="btn" onClick={closeDialog}>Close</button>}
              {update.stage === 'installing' && <button type="button" className="btn pri" disabled>Restarting</button>}
              {step.kind !== 'none' && <button type="button" className="btn pri" disabled={working} onClick={() => run(step)}>{step.label}</button>}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
