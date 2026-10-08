import { useId } from 'react'
import { Download } from 'lucide-react'
import { announcedUpdate, putOffUpdate, useStepRunner, useUpdates } from '../state/updates'
import { nextStep, noticeDetail, noticeTitle, progressPercent, type Update } from '../lib/updateText'
import { BusyConfirm, ProgressLine } from './UpdateParts'
import './update.css'

/**
 * One release on offer and the one step that moves it on, with a way to read what changed. In the sidebar it can be
 * put off with "Later"; on the Settings page there is no later, only a way to skip the version.
 */
export function UpdateCard({ update, placement }: { update: Update; placement: 'side' | 'page' }): JSX.Element {
  const state = useUpdates((store) => store.state)
  const busy = useUpdates((store) => store.busy)
  const problem = useUpdates((store) => store.problem)
  const pending = useUpdates((store) => store.pending)
  const dismiss = useUpdates((store) => store.dismiss)
  const skip = useUpdates((store) => store.skip)
  const openDialog = useUpdates((store) => store.openDialog)
  const cancelDownload = useUpdates((store) => store.cancelDownload)
  const run = useStepRunner()
  const titleId = useId()
  // In the sidebar the card is a region of its own. On the Settings page it sits in a named group already, and a
  // second region of the same name would only repeat it.
  const Wrap = placement === 'side' ? 'section' : 'div'

  const step = nextStep(state, update)
  const error = update.error ?? problem
  const idleStage = update.stage === 'available' || update.stage === 'ready'
  const asking = busy !== undefined && update.stage === 'ready'
  const working = (step.kind === 'download' && pending === 'download') || (step.kind === 'restart' && pending === 'install')

  return (
    <Wrap className={`upd upd--${placement}`} role={placement === 'page' ? 'group' : undefined} aria-labelledby={titleId} data-stage={update.stage}>
      <div className="upd__title" id={titleId}>{noticeTitle(update)}</div>
      <p className="upd__detail">
        {noticeDetail(state, update)}
        {update.stage !== 'installing' && <>{' '}<button type="button" className="upd__link" onClick={openDialog}>What&rsquo;s new</button></>}
      </p>
      {update.skipped && placement === 'page' && <p className="upd__detail">You chose to skip this version, so Cubex does not announce it.</p>}
      {update.stage === 'downloading' && <ProgressLine update={update} label={`Download of Cubex ${update.info.version}`} />}
      {error && <p className="upd__error" role="alert">{error}</p>}
      {asking ? <BusyConfirm /> : (
        <div className="upd__actions">
          {update.stage === 'downloading' && (
            <button type="button" className="btn sm ghost" disabled={pending === 'cancel'} onClick={() => void cancelDownload()}>Cancel</button>
          )}
          {idleStage && placement === 'side' && <button type="button" className="btn sm ghost" onClick={dismiss}>Later</button>}
          {idleStage && placement === 'page' && !update.skipped && (
            <button type="button" className="btn sm ghost" disabled={pending === 'skip'} onClick={() => void skip()}>Skip this version</button>
          )}
          {step.kind !== 'none' && (
            <button type="button" className="btn sm pri" disabled={working} onClick={() => run(step)}>{step.label}</button>
          )}
        </div>
      )}
    </Wrap>
  )
}

/**
 * The card in the sidebar when a newer Cubex is out. It is not an alert: it sits in the layout, never over the
 * conversation, and never takes the focus.
 */
export function UpdateNotice(): JSX.Element | null {
  const update = useUpdates((store) => announcedUpdate(store))
  return update ? <UpdateCard update={update} placement="side" /> : null
}

/** After "Later" the card is gone, and this is the quiet way back to it. */
export function UpdateLink(): JSX.Element | null {
  const update = useUpdates((store) => putOffUpdate(store))
  const openDialog = useUpdates((store) => store.openDialog)
  if (!update) return null
  return (
    <button type="button" className="side-link" onClick={openDialog} aria-haspopup="dialog">
      <Download size={15} aria-hidden="true" />
      Update available
      <span className="tag">{update.info.version}</span>
    </button>
  )
}

/** With the sidebar hidden there is no card, so the title bar carries the same news in one small button. */
export function UpdateTitleButton(): JSX.Element | null {
  const state = useUpdates((store) => store.state)
  const openDialog = useUpdates((store) => store.openDialog)
  const { update } = state
  if (!update || update.skipped) return null
  const percent = progressPercent(update.progress)
  const label = update.stage === 'available' ? 'Update available'
    : update.stage === 'downloading' ? (percent === undefined || percent === 0 ? 'Downloading' : `Downloading ${percent}%`)
    : update.stage === 'ready' ? 'Restart to update'
    : 'Restarting'
  return (
    <button type="button" className="tb-update" onClick={openDialog} aria-haspopup="dialog" title={noticeTitle(update)} disabled={update.stage === 'installing'}>
      <Download size={13} aria-hidden="true" />
      <span>{label}</span>
    </button>
  )
}

/**
 * Says the big moments aloud: an update was found, it is downloading, it is ready, something failed. It is not the
 * progress bar, which would speak ten times a second.
 */
export function UpdateAnnouncer(): JSX.Element {
  const update = useUpdates((store) => store.state.update)
  const text = update && !update.skipped ? (update.error ?? noticeTitle(update)) : ''
  return <div className="sr-only" role="status" aria-live="polite">{text}</div>
}
