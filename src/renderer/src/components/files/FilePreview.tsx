import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, AtSign, Check, Copy, FileSearch, FileQuestion, FolderOpen } from 'lucide-react'
import { FILE_PREVIEW_BYTES, FILE_PREVIEW_MAX_BYTES, type WorkspaceFileResult } from '../../../../shared/workspaceFile'
import { api, formatBytes } from '../../lib/api'
import { isMarkdownPath, isSvgPath, languageName } from '../../lib/fileKinds'
import { ActivityGlyph } from '../../theme/StateIcons'
import { useStore } from '../../state/store'
import { useFiles } from '../../state/files'
import { Markdown } from '../Markdown'
import { CodeView } from './CodeView'

type Read =
  | { status: 'idle' }
  | { status: 'loading'; path: string }
  | { status: 'ready'; path: string; result: WorkspaceFileResult }
  | { status: 'error'; path: string; message: string }

/**
 * Reads the open file, and again whenever `version` changes (the agent edited it). While the same
 * file reloads, the old content stays up so the view does not flash.
 */
function useFileRead(path: string | undefined, conversationId: string | undefined, maxBytes: number, version: string): Read {
  const [read, setRead] = useState<Read>({ status: 'idle' })
  useEffect(() => {
    if (!path) {
      setRead({ status: 'idle' })
      return
    }
    let live = true
    setRead((current) => (current.status === 'ready' && current.path === path ? current : { status: 'loading', path }))
    api.readWorkspaceFile(path, conversationId, { maxBytes }).then(
      (result) => { if (live) setRead({ status: 'ready', path, result }) },
      (cause: unknown) => { if (live) setRead({ status: 'error', path, message: cause instanceof Error ? cause.message : 'The file could not be opened.' }) }
    )
    return () => { live = false }
  }, [path, conversationId, maxBytes, version])
  return read
}

/** True for a moment after `trigger`, for the "Copied" feedback on a button. */
function useBrief(ms = 1400): [boolean, () => void] {
  const [on, setOn] = useState(false)
  const timer = useRef<number>()
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const trigger = useCallback(() => {
    setOn(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setOn(false), ms)
  }, [ms])
  return [on, trigger]
}

function Header({ path, result, onBack }: { path: string; result: WorkspaceFileResult | undefined; onBack: () => void }): JSX.Element {
  const conversationId = useStore((state) => state.activeConversation?.id)
  const appendToComposer = useStore((state) => state.appendToComposer)
  const line = useFiles((state) => state.line)
  const source = useFiles((state) => state.source)
  const setSource = useFiles((state) => state.setSource)
  const [copied, flashCopied] = useBrief()
  const [added, flashAdded] = useBrief()
  const [failure, setFailure] = useState<string>()
  const slash = path.lastIndexOf('/')
  const dir = slash < 0 ? '' : path.slice(0, slash + 1)
  const name = slash < 0 ? path : path.slice(slash + 1)
  const rendered = result?.kind === 'text' && (isMarkdownPath(path) || isSvgPath(path))

  useEffect(() => setFailure(undefined), [path])

  const copy = (): void => {
    if (result?.kind !== 'text') return
    void navigator.clipboard.writeText(result.content).then(flashCopied, () => setFailure('Copying was blocked. Select the text and copy it instead.'))
  }
  const reveal = (): void => {
    api.revealPath(path, conversationId).catch((cause: unknown) => setFailure(cause instanceof Error ? cause.message : 'The folder could not be opened.'))
  }
  const addToMessage = (): void => {
    // A trailing space lets the person keep typing; the marked line narrows the mention to it.
    appendToComposer(`@${path}${line ? `:${line}` : ''} `)
    flashAdded()
  }

  return (
    <>
      <header className="fx-head">
        <button type="button" className="ib fx-back" onClick={onBack} aria-label="Back to files" title="Back to files"><ArrowLeft size={16} /></button>
        <div className="fx-path" title={path}>
          {dir && <span className="fx-path__dir"><bdi>{dir}</bdi></span>}
          <span className="fx-path__name">{name}</span>
        </div>
        {rendered && (
          <div className="seg fx-seg" role="group" aria-label="View as">
            <button type="button" className={`seg__btn ${source ? '' : 'seg__btn--on'}`} aria-pressed={!source} onClick={() => setSource(false)}>Preview</button>
            <button type="button" className={`seg__btn ${source ? 'seg__btn--on' : ''}`} aria-pressed={source} onClick={() => setSource(true)}>Source</button>
          </div>
        )}
        <button type="button" className="btn ghost sm fx-act" onClick={copy} disabled={result?.kind !== 'text'} title={result?.kind === 'text' && result.truncated ? 'Copy the part that is loaded' : 'Copy the contents'}>
          {copied ? <Check size={14} /> : <Copy size={14} />}<span className="fx-act__label">{copied ? 'Copied' : 'Copy'}</span>
        </button>
        <button type="button" className="btn ghost sm fx-act" onClick={addToMessage} title="Add this file to your message">
          {added ? <Check size={14} /> : <AtSign size={14} />}<span className="fx-act__label">{added ? 'Added' : 'Add to message'}</span>
        </button>
        <button type="button" className="btn ghost sm fx-act" onClick={reveal} title="Reveal in folder">
          <FolderOpen size={14} /><span className="fx-act__label">Reveal in folder</span>
        </button>
      </header>
      {failure && <div className="callout callout--error fx-notice" role="alert"><div className="callout__body">{failure}</div></div>}
    </>
  )
}

function Footer({ result, line, dimensions }: { result: WorkspaceFileResult; line: number | undefined; dimensions: string | undefined }): JSX.Element {
  const size = result.size === 0 ? 'Empty' : formatBytes(result.size)
  if (result.kind === 'text') {
    const ending = { lf: 'LF', crlf: 'CRLF', cr: 'CR', mixed: 'Mixed line endings', none: '' }[result.lineEnding]
    return (
      <footer className="fx-meta">
        {line && <span className="fx-meta__line">Line {line}</span>}
        <span>{result.truncated ? `${result.lineCount.toLocaleString()} lines loaded` : `${result.lineCount.toLocaleString()} ${result.lineCount === 1 ? 'line' : 'lines'}`}</span>
        <span>{size}</span>
        <span className="fx-meta__end">
          {ending && <span>{ending}</span>}
          <span>{result.encoding === 'utf-8' ? (result.bom ? 'UTF-8 with BOM' : 'UTF-8') : result.encoding === 'utf-16le' ? 'UTF-16 LE' : 'UTF-16 BE'}</span>
          <span>{languageName(result.path)}</span>
        </span>
      </footer>
    )
  }
  return (
    <footer className="fx-meta">
      {dimensions && <span>{dimensions}</span>}
      <span>{size}</span>
      {result.kind === 'image' && <span className="fx-meta__end"><span>{result.mime.replace('image/', '').replace('x-icon', 'icon').toUpperCase()}</span></span>}
    </footer>
  )
}

function ImageBody({ src, name, onSize }: { src: string; name: string; onSize: (dimensions: string) => void }): JSX.Element {
  const [actual, setActual] = useState(false)
  return (
    <div className="fx-image" data-actual={actual || undefined}>
      <button type="button" className="fx-image__fit" onClick={() => setActual((value) => !value)} aria-label={actual ? 'Fit the image to the panel' : 'Show the image at actual size'} title={actual ? 'Fit to panel' : 'Actual size'}>
        <img src={src} alt={name} draggable={false} onLoad={(event) => onSize(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`)} />
      </button>
    </div>
  )
}

function svgUrl(content: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`
}

/** The file chosen in the tree: its path and actions, then its text, rendering, picture or a note that it cannot be shown. */
export function FilePreview({ path, version, onBack }: { path: string; version: string; onBack: () => void }): JSX.Element {
  const conversationId = useStore((state) => state.activeConversation?.id)
  const line = useFiles((state) => state.line)
  const focus = useFiles((state) => state.focus)
  const source = useFiles((state) => state.source)
  const [maxBytes, setMaxBytes] = useState(FILE_PREVIEW_BYTES)
  const [dimensions, setDimensions] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const read = useFileRead(path, conversationId, maxBytes, `${version}:${attempt}`)

  useEffect(() => {
    setMaxBytes(FILE_PREVIEW_BYTES)
    setDimensions(undefined)
  }, [path])

  const mark = useCallback((next: number | undefined) => useFiles.setState({ line: next }), [])
  const result = read.status === 'ready' && read.path === path ? read.result : undefined
  const reveal = (): void => { void api.revealPath(path, conversationId).catch(() => undefined) }

  type Body = { kind: 'state' | 'code' | 'prose' | 'image'; node: JSX.Element }
  const bodyFor = (): Body => {
    if (read.status === 'error' && read.path === path) {
      return {
        kind: 'state',
        node: (
          <div className="fx-state">
            <div className="callout callout--error" role="alert">
              <div className="callout__body"><strong>This file could not be opened</strong>{read.message}</div>
              <div className="callout__actions"><button type="button" className="callout__action" onClick={() => setAttempt((value) => value + 1)}>Try again</button></div>
            </div>
          </div>
        )
      }
    }
    if (!result) {
      return { kind: 'state', node: <div className="fx-loading" role="status"><ActivityGlyph kind="thinking" size={16} active /><span>Opening {path.slice(path.lastIndexOf('/') + 1)}</span></div> }
    }
    if (result.kind === 'binary') {
      return {
        kind: 'state',
        node: (
          <div className="rev-empty">
            <FileQuestion size={22} strokeWidth={1.5} aria-hidden="true" />
            <h2>Binary file</h2>
            <p>Cubex shows text and images. This file is {formatBytes(result.size)}; reveal it in the folder to open it with another app.</p>
            <button type="button" className="btn sm" onClick={reveal}><FolderOpen size={14} />Reveal in folder</button>
          </div>
        )
      }
    }
    if (result.kind === 'image') {
      if (result.dataUrl) return { kind: 'image', node: <ImageBody src={result.dataUrl} name={result.name} onSize={setDimensions} /> }
      return {
        kind: 'state',
        node: (
          <div className="rev-empty">
            <FileQuestion size={22} strokeWidth={1.5} aria-hidden="true" />
            <h2>Image too large to preview</h2>
            <p>This image is {formatBytes(result.size)}. Reveal it in the folder to open it with another app.</p>
            <button type="button" className="btn sm" onClick={reveal}><FolderOpen size={14} />Reveal in folder</button>
          </div>
        )
      }
    }
    if (!source && isMarkdownPath(path)) {
      return { kind: 'prose', node: <div className="fx-scroll"><div className="prose fx-prose"><Markdown text={result.content} /></div></div> }
    }
    if (!source && isSvgPath(path)) return { kind: 'image', node: <ImageBody src={svgUrl(result.content)} name={result.name} onSize={setDimensions} /> }
    return { kind: 'code', node: <CodeView path={path} text={result.content} line={line} focus={focus} onPick={mark} /> }
  }

  const body = bodyFor()
  const canLoadMore = result?.kind === 'text' && result.truncated && maxBytes < FILE_PREVIEW_MAX_BYTES && result.size > maxBytes

  return (
    <>
      <Header path={path} result={result} onBack={onBack} />
      {result?.kind === 'text' && result.truncated && (
        <div className="callout fx-notice" role="status">
          <div className="callout__body">
            Showing the first {formatBytes(maxBytes)} of {formatBytes(result.size)}.
            {canLoadMore ? '' : ' Open the file in an editor to see the rest.'}
          </div>
          {canLoadMore && <div className="callout__actions"><button type="button" className="callout__action" onClick={() => setMaxBytes(FILE_PREVIEW_MAX_BYTES)}>Load up to {formatBytes(FILE_PREVIEW_MAX_BYTES)}</button></div>}
        </div>
      )}
      <div className="fx-doc" data-body={body.kind}>{body.node}</div>
      {result && <Footer result={result} line={body.kind === 'code' ? line : undefined} dimensions={dimensions} />}
    </>
  )
}

/** Shown beside the tree when no file is open. */
export function EmptyPreview(): JSX.Element {
  return (
    <div className="rev-empty">
      <FileSearch size={22} strokeWidth={1.5} aria-hidden="true" />
      <h2>No file open</h2>
      <p>Choose a file in the tree, or search for one by name. Paths in the conversation open here too.</p>
    </div>
  )
}
