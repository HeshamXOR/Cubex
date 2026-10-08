import { useEffect, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import type { ShellId } from '../../../../../shared/ipc'
import { api } from '../../../lib/api'
import { useStore } from '../../../state/store'
import type { SettingsSection } from '../registry'
import { RowShell } from '../rows'
import './shell.css'

type Listing = Array<{ id: ShellId; label: string; path: string; available: boolean }>

/** The syntax the model is told to write for each shell. */
const SYNTAX: Record<ShellId, string> = {
  'git-bash': 'Bash', pwsh: 'PowerShell', powershell: 'PowerShell', cmd: 'Command Prompt', posix: 'sh'
}

function ShellPicker(): JSX.Element {
  const settings = useStore((state) => state.settings)
  const save = useStore((state) => state.saveSettings)
  const [shells, setShells] = useState<Listing>()
  const [error, setError] = useState<string>()
  const [saveError, setSaveError] = useState<string>()
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    setError(undefined)
    api.listShells().then(
      (list) => { if (alive) setShells(list) },
      (reason: unknown) => { if (alive) setError(reason instanceof Error ? reason.message : String(reason)) }
    )
    return () => { alive = false }
  }, [attempt])

  const preferred = settings?.shell?.preferred ?? 'auto'
  // The list comes back in the order Auto tries, so the first one found is the one Auto uses.
  const auto = shells?.find((shell) => shell.available)
  const chosen = shells?.find((shell) => shell.id === preferred)
  const unavailable = preferred !== 'auto' && shells !== undefined && !chosen?.available

  const choose = async (value: string): Promise<void> => {
    setSaveError(undefined)
    try {
      await save({ shell: { preferred: value as ShellId | 'auto' } })
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  if (error) {
    return (
      <div className="callout callout--error shellsec" role="alert">
        <TriangleAlert size={14} aria-hidden="true" />
        <div className="callout__body">
          <strong>Could not list the shells on this computer</strong>
          {error}
        </div>
        <div className="callout__actions"><button type="button" className="callout__action" onClick={() => setAttempt((value) => value + 1)}>Try again</button></div>
      </div>
    )
  }
  if (!shells) return <p className="setgroup__note" role="status">Looking for installed shells…</p>
  if (shells.length === 0) return <p className="setgroup__note">No shell was found on this computer, so commands cannot run.</p>

  const hint = preferred === 'auto'
    ? `Auto uses the first shell Cubex finds${auto ? `, which is ${auto.label} here` : ''}.`
    : chosen?.available ? `The model is told to write ${SYNTAX[chosen.id]} commands.` : undefined

  return (
    <div className="shellsec">
      <p className="setgroup__note">Cubex runs commands in this shell, including the ones it leaves running in the background. A change applies from your next message.</p>
      <RowShell label="Shell for commands" hint={hint}>
        <select className="select shellpick" aria-label="Shell for commands" value={preferred} onChange={(event) => void choose(event.target.value)}>
          <option value="auto">{auto ? `Auto (${auto.label})` : 'Auto'}</option>
          {shells.map((shell) => (
            <option key={shell.id} value={shell.id} disabled={!shell.available}>{shell.available ? shell.label : `${shell.label} (not installed)`}</option>
          ))}
          {preferred !== 'auto' && !chosen && <option value={preferred} disabled>{preferred} (not available here)</option>}
        </select>
      </RowShell>
      {unavailable && (
        <p className="callout callout--warn">
          <TriangleAlert size={14} aria-hidden="true" />
          <span className="callout__body">
            {chosen ? `${chosen.label} is not installed` : 'The saved shell is not available here'}, so commands run in {auto?.label ?? 'the default shell'} instead. Choose another shell{chosen ? ` or install ${chosen.label}` : ''}.
          </span>
        </p>
      )}
      {saveError && (
        <p className="callout callout--error" role="alert">
          <TriangleAlert size={14} aria-hidden="true" />
          <span className="callout__body">Could not save the shell. {saveError}</span>
        </p>
      )}
      <dl className="shells" aria-label="Shells on this computer">
        {shells.map((shell) => (
          <div className="shells__row" key={shell.id}>
            <dt>{shell.label}</dt>
            <dd className={shell.available ? 'mono' : undefined} title={shell.available ? shell.path : undefined}>{shell.available ? shell.path : 'Not installed'}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

export const section: SettingsSection = { id: 'shell', title: 'Shell', page: 'tools', order: 100, Component: ShellPicker }
