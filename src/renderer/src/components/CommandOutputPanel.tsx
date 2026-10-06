import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ArrowRight, Check, Copy, FolderOpen, Terminal, WrapText, X } from 'lucide-react'
import type { CommandOutputArtifact, CommandOutputPage } from '../../../shared/ipc'
import { api } from '../lib/api'
import { displayOutput } from '../lib/terminalText'
import './command-output.css'

const PAGE_BYTES = 32 * 1024
const STATUS: Record<CommandOutputArtifact['status'], string> = {
  running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled',
  timed_out: 'Timed out', interrupted: 'Interrupted'
}
const bytes = (value: number): string => value < 1024 ? `${value} B` : `${Number((value / 1024).toFixed(1))} KB`

/** A bounded log reader. Native modal semantics keep keyboard focus in the viewer. */
export function CommandOutputPanel({ conversationId, outputId, onClose }: {
  conversationId: string; outputId: string; onClose: () => void
}): JSX.Element {
  const id = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const body = useRef<HTMLPreElement>(null)
  const [offsets, setOffsets] = useState([0])
  const [page, setPage] = useState<CommandOutputPage>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [retry, setRetry] = useState(0)
  const [wrap, setWrap] = useState(false)
  const [copied, setCopied] = useState(false)
  const offset = offsets[offsets.length - 1]!

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
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
    setActionError('')
    setCopied(false)
    void api.readCommandOutput(conversationId, outputId, offset, PAGE_BYTES).then((result) => {
      if (disposed) return
      setPage(result)
      setLoading(false)
      body.current?.scrollTo(0, 0)
    }).catch((reason: unknown) => {
      if (disposed) return
      setError(reason instanceof Error ? reason.message : String(reason))
      setLoading(false)
    })
    return () => { disposed = true }
  }, [conversationId, outputId, offset, retry])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1800)
    return () => clearTimeout(timer)
  }, [copied])

  const copyPage = async (): Promise<void> => {
    if (!page || loading || error) return
    try {
      await navigator.clipboard.writeText(displayOutput(page.text))
      setActionError('')
      setCopied(true)
    } catch { setActionError('Could not copy this page. Select the output to copy it manually.') }
  }
  const reveal = async (): Promise<void> => {
    try { await api.revealCommandOutput(conversationId, outputId); setActionError('') }
    catch (reason) { setActionError(reason instanceof Error ? reason.message : String(reason)) }
  }
  const artifact = page?.artifact
  const end = page ? page.nextOffset ?? page.artifact.capturedBytes : 0
  const readable = !!page && !loading && !error

  return createPortal(
    <dialog ref={dialog} className="command-output" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
      onCancel={(event) => { event.preventDefault(); onClose() }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
      }}>
      <header className="command-output__header">
        <Terminal size={19} strokeWidth={1.6} aria-hidden="true" />
        <div className="command-output__identity"><h2 id={`${id}-title`}>Command output</h2><p id={`${id}-description`}>Saved in this task</p></div>
        <button className="command-output__icon" aria-label="Close command output" onClick={onClose} autoFocus><X size={18} /></button>
      </header>
      {artifact && <div className="command-output__command"><span aria-hidden="true">$</span><code>{artifact.command}</code></div>}
      <div className="command-output__toolbar">
        <span className="command-output__status" data-status={artifact?.status}>
          <span aria-hidden="true" />{artifact ? STATUS[artifact.status] : 'Output'}
          {artifact?.exitCode !== undefined && <small>exit {artifact.exitCode}</small>}
        </span>
        <div className="command-output__actions">
          <button className="command-output__icon" aria-label="Wrap output lines" aria-pressed={wrap} title="Wrap output lines" onClick={() => setWrap(value => !value)}><WrapText size={16} /></button>
          <button className="command-output__icon" aria-label={copied ? 'Page copied' : 'Copy output page'} title={copied ? 'Page copied' : 'Copy output page'} disabled={!readable} onClick={() => void copyPage()}>{copied ? <Check size={16} /> : <Copy size={15} />}</button>
          <button className="command-output__icon" aria-label="Reveal saved output file" title="Reveal saved output file" disabled={!artifact} onClick={() => void reveal()}><FolderOpen size={16} /></button>
        </div>
      </div>
      {loading ? <div className="command-output__empty" role="status">Loading saved output…</div>
        : error ? <div className="command-output__empty"><p role="alert">{error}</p><button onClick={() => setRetry(value => value + 1)}>Try again</button></div>
          : <pre ref={body} className={`command-output__text ${wrap ? 'is-wrapped' : ''}`} tabIndex={0} aria-label="Saved output page"><code>{page?.text ? displayOutput(page.text) : '(no output)'}</code></pre>}
      {artifact?.truncated && <p className="command-output__notice">Output capture is incomplete. {bytes(artifact.capturedBytes)} saved{artifact.totalBytes !== undefined ? ` of ${bytes(artifact.totalBytes)} produced` : ''}; later output is unavailable.</p>}
      {artifact?.error && <p className="command-output__notice">{artifact.error}</p>}
      {actionError && <p className="command-output__notice" role="alert">{actionError}</p>}
      <footer className="command-output__footer">
        <span aria-live="polite">{readable ? `${offset.toLocaleString()}–${end.toLocaleString()} of ${artifact!.capturedBytes.toLocaleString()} bytes` : 'Saved output'}{readable && page?.eof ? ' (End)' : ''}</span>
        <nav aria-label="Command output pages">
          <button aria-label="Previous output page" disabled={offsets.length < 2 || loading} onClick={() => setOffsets(value => value.slice(0, -1))}><ArrowLeft size={15} /></button>
          <span>Page {offsets.length}</span>
          <button aria-label="Next output page" disabled={!readable || page?.nextOffset === undefined} onClick={() => { if (page?.nextOffset !== undefined) setOffsets(value => [...value, page.nextOffset!]) }}><ArrowRight size={15} /></button>
        </nav>
      </footer>
    </dialog>, document.body
  )
}
