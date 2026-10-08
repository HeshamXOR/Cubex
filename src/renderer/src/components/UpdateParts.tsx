import { useEffect, useRef } from 'react'
import { useUpdates } from '../state/updates'
import { busyText, progressPercent, progressText, type Update } from '../lib/updateText'

/** How far a download is: a thin bar and the bytes. The bar is the one place blue is used. */
export function ProgressLine({ update, label }: { update: Update; label: string }): JSX.Element {
  const percent = progressPercent(update.progress)
  const text = progressText(update.progress)
  return (
    <div className="updp">
      <div
        className="progress updp__bar"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(percent !== undefined && update.progress && update.progress.received > 0 ? { 'aria-valuenow': percent, 'aria-valuetext': text } : {})}
      >
        <div className="progress__bar" style={{ width: `${percent ?? 0}%` }} />
      </div>
      <div className="updp__text">{text}</div>
    </div>
  )
}

/**
 * Restarting would stop work that is running. This asks, and replaces the buttons that were pressed. "Wait" has
 * the focus, so a key press cannot stop work by accident.
 */
export function BusyConfirm(): JSX.Element | null {
  const busy = useUpdates((store) => store.busy)
  const pending = useUpdates((store) => store.pending)
  const install = useUpdates((store) => store.install)
  const waitForWork = useUpdates((store) => store.waitForWork)
  const wait = useRef<HTMLButtonElement>(null)
  const shown = busy !== undefined
  useEffect(() => { if (shown) wait.current?.focus() }, [shown])
  if (!busy) return null
  return (
    <div className="updb" role="alert">
      <p className="updb__text">{busyText(busy)}</p>
      <div className="updb__actions">
        <button type="button" className="btn sm ghost" ref={wait} onClick={waitForWork}>Wait</button>
        <button type="button" className="btn sm pri" disabled={pending === 'install'} onClick={() => void install(true)}>Stop and update</button>
      </div>
    </div>
  )
}
