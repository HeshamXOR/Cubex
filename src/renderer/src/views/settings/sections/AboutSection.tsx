import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, FolderOpen, TriangleAlert } from 'lucide-react'
import type { AppFolderKind, AppInfo } from '../../../../../shared/ipc'
import { aboutDetails, buildKind, runtimeLine, systemLine } from '../../../lib/aboutInfo'
import { api } from '../../../lib/api'
import type { SettingsSection } from '../registry'
import { RowShell } from '../rows'
import './about.css'

/** How long "Copied" stays on the button before it goes back to "Copy details". */
const COPIED_MS = 2000

const FOLDER_NAMES: Record<AppFolderKind, string> = { data: 'data folder', logs: 'logs folder' }

function FolderValue({ kind, path, onOpen }: { kind: AppFolderKind; path: string; onOpen: (kind: AppFolderKind) => void }): JSX.Element {
  return (
    <dd className="about__where">
      <span className="about__path mono" title={path}>{path}</span>
      <button type="button" className="btn btn--sm btn--ghost" aria-label={`Open ${FOLDER_NAMES[kind]}`} onClick={() => onOpen(kind)}>
        <FolderOpen size={13} aria-hidden="true" />
        Open
      </button>
    </dd>
  )
}

function AboutDetails(): JSX.Element {
  const [info, setInfo] = useState<AppInfo>()
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const [copied, setCopied] = useState(false)
  const [problem, setProblem] = useState<string>()
  const copiedTimer = useRef<number>()

  useEffect(() => {
    let alive = true
    setError(undefined)
    api.appInfo().then(
      (next) => { if (alive) setInfo(next) },
      (reason: unknown) => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)) }
    )
    return () => { alive = false }
  }, [attempt])
  useEffect(() => () => window.clearTimeout(copiedTimer.current), [])

  const openFolder = useCallback(async (kind: AppFolderKind): Promise<void> => {
    setProblem(undefined)
    try {
      const failure = await api.openAppFolder(kind)
      if (failure) setProblem(`Could not open the ${FOLDER_NAMES[kind]}. ${failure}`)
    } catch (reason) {
      setProblem(`Could not open the ${FOLDER_NAMES[kind]}. ${reason instanceof Error ? reason.message : String(reason)}`)
    }
  }, [])

  const copyDetails = async (): Promise<void> => {
    if (!info) return
    setProblem(undefined)
    try {
      await navigator.clipboard.writeText(aboutDetails(info))
      setCopied(true)
      window.clearTimeout(copiedTimer.current)
      copiedTimer.current = window.setTimeout(() => setCopied(false), COPIED_MS)
    } catch {
      setProblem('Copying was blocked. Select the values above and copy them instead.')
    }
  }

  if (error) {
    return (
      <div className="callout callout--error" role="alert">
        <TriangleAlert size={14} aria-hidden="true" />
        <div className="callout__body">
          <strong>Could not read the version details</strong>
          {error}
        </div>
        <div className="callout__actions"><button type="button" className="callout__action" onClick={() => setAttempt((value) => value + 1)}>Try again</button></div>
      </div>
    )
  }
  if (!info) return <p className="setgroup__note" role="status">Reading version details…</p>

  return (
    <div className="about">
      <dl className="about__facts" aria-label="This installation">
        <div className="about__row">
          <dt>Version</dt>
          <dd>{info.version}<span className="about__build">{buildKind(info)}</span></dd>
        </div>
        <div className="about__row">
          <dt>Runtime</dt>
          <dd>{runtimeLine(info)}</dd>
        </div>
        <div className="about__row">
          <dt>System</dt>
          <dd>{systemLine(info)}</dd>
        </div>
        <div className="about__row">
          <dt>Data folder</dt>
          <FolderValue kind="data" path={info.dataDir} onOpen={(kind) => void openFolder(kind)} />
        </div>
        <div className="about__row">
          <dt>Logs folder</dt>
          <FolderValue kind="logs" path={info.logsDir} onOpen={(kind) => void openFolder(kind)} />
        </div>
      </dl>
      <RowShell label="Bug report details" hint="Version, system and folder locations as plain text.">
        <button type="button" className="btn btn--sm" onClick={() => void copyDetails()}>
          {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy details'}
        </button>
      </RowShell>
      <div className="sr-only" role="status">{copied ? 'Details copied to the clipboard.' : ''}</div>
      {problem && (
        <p className="callout callout--warn" role="alert">
          <TriangleAlert size={14} aria-hidden="true" />
          <span className="callout__body">{problem}</span>
        </p>
      )}
    </div>
  )
}

export const section: SettingsSection = { id: 'about', title: 'About', order: 900, placement: 'end', Component: AboutDetails }
