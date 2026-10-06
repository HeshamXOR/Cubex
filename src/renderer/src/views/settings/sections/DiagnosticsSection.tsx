import { useEffect, useState } from 'react'
import { Check, CircleAlert } from 'lucide-react'
import type { DiagnosticsStatus } from '../../../../../shared/ipc'
import { api } from '../../../lib/api'
import { basename } from '../../../lib/format'
import { useStore } from '../../../state/store'
import { ActivityGlyph } from '../../../theme/StateIcons'
import type { SettingsSection } from '../registry'
import { ToggleRow } from '../rows'
import './diagnostics.css'

/** How often the status line looks again while Settings is open: a tsconfig added or removed shows up within seconds. */
const REFRESH_MS = 5000

/** What the checker says about the open task's folder (the selected folder without one). Undefined until it answers. */
function useCheckerStatus(conversationId: string | undefined, enabled: boolean): DiagnosticsStatus | undefined {
  const [status, setStatus] = useState<DiagnosticsStatus>()
  useEffect(() => {
    let alive = true
    const ask = (): void => {
      api.getDiagnosticsStatus(conversationId).then(
        (next) => { if (alive) setStatus(next) },
        () => { if (alive) setStatus({ available: false, reason: 'The type checker did not answer. Restart Cubex if this stays.' }) }
      )
    }
    ask()
    const timer = window.setInterval(ask, REFRESH_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [conversationId, enabled])
  return status
}

function StatusLine({ on, status, folder }: { on: boolean; status: DiagnosticsStatus | undefined; folder: string | undefined }): JSX.Element {
  if (!on) {
    return <div className="setrow diag-status" role="status">Edits are not checked.</div>
  }
  if (!status) {
    return <div className="setrow diag-status" role="status"><ActivityGlyph kind="thinking" size={14} active />Looking for TypeScript</div>
  }
  if (!status.available) {
    return <div className="setrow diag-status diag-status--attention" role="status"><CircleAlert size={14} aria-hidden="true" />{status.reason ?? 'Edits cannot be checked in this folder.'}</div>
  }
  return (
    <div className="setrow diag-status diag-status--ok" role="status">
      <Check size={14} aria-hidden="true" />
      {status.version ? `TypeScript ${status.version}` : 'TypeScript'} checks edits{folder ? ` in ${folder}` : ''}.
    </div>
  )
}

function DiagnosticsSettings(): JSX.Element {
  const settings = useStore((state) => state.settings)
  const save = useStore((state) => state.saveSettings)
  const conversationId = useStore((state) => state.activeConversation?.id)
  const workspace = useStore((state) => (state.activeConversation ? state.activeConversation.workspacePath : state.settings?.general.workspacePath))
  const on = settings?.diagnostics?.afterEdit === 'errors'
  const status = useCheckerStatus(conversationId, on)

  return (
    <>
      <ToggleRow
        label="Check edits for type errors"
        hint="After Cubex edits a TypeScript or JavaScript file, the model is told about any new compiler errors so it can fix them. Needs a tsconfig.json or jsconfig.json in the project."
        on={on}
        onChange={(next) => void save({ diagnostics: { afterEdit: next ? 'errors' : 'off' } })}
      />
      <StatusLine on={on} status={status} folder={workspace ? basename(workspace) : undefined} />
    </>
  )
}

export const section: SettingsSection = { id: 'diagnostics', title: 'Type checking', order: 110, Component: DiagnosticsSettings }
