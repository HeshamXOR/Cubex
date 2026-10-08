import { useStore } from '../../../state/store'
import type { SettingsSection } from '../registry'
import { RowShell, ToggleRow } from '../rows'
import { useSettingsEditor } from '../useSettingsEditor'

function GeneralSettings(): JSX.Element | null {
  const editor = useSettingsEditor()
  const pickWorkspace = useStore((state) => state.pickWorkspace)
  const clearWorkspace = useStore((state) => state.clearWorkspace)
  if (!editor) return null
  const { settings, patch } = editor
  return (
    <>
      <ToggleRow label="Start maximized" on={settings.general.startMaximized} onChange={(v) => patch('general', { startMaximized: v })} />
      <RowShell label="Working folder" hint={settings.general.workspacePath ?? 'No folder selected. Choose one so the model knows where your project is.'}>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" onClick={() => void pickWorkspace()}>Choose folder</button>
          {settings.general.workspacePath && (
            <button className="btn btn--ghost" onClick={() => void clearWorkspace()}>Clear</button>
          )}
        </div>
      </RowShell>
    </>
  )
}

export const section: SettingsSection = { id: 'general', title: 'General', page: 'general', order: 10, Component: GeneralSettings }
