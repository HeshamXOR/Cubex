import type { SettingsSection } from '../registry'
import { ToggleRow } from '../rows'
import { useSettingsEditor } from '../useSettingsEditor'

function PrivacySettings(): JSX.Element | null {
  const editor = useSettingsEditor()
  if (!editor) return null
  const { settings, patch } = editor
  return (
    <>
      <p className="setgroup__note">Provider credentials are encrypted with your operating system's keychain.</p>
      <ToggleRow label="Local-only mode" hint="Use local model providers from the next request or retry. Also turns off update checks and the agent programs under Other agents. Does not block tools or model downloads." on={settings.privacy.localOnly} onChange={(v) => patch('privacy', { localOnly: v })} />
      <ToggleRow label="Local logging" hint="Structured logs are kept on this PC, with secrets always redacted." on={settings.privacy.localLogging} onChange={(v) => patch('privacy', { localLogging: v })} />
    </>
  )
}

export const section: SettingsSection = { id: 'privacy', title: 'Privacy', page: 'privacy', order: 10, Component: PrivacySettings }
