import type { SettingsSection } from '../registry'
import { NumRow, TextRow } from '../rows'
import { useSettingsEditor } from '../useSettingsEditor'

function LocalAiSettings(): JSX.Element | null {
  const editor = useSettingsEditor()
  if (!editor) return null
  const { settings, patch } = editor
  return (
    <>
      <TextRow label="Ollama base URL" value={settings.local.ollamaBaseUrl} onChange={(v) => patch('local', { ollamaBaseUrl: v })} />
      <TextRow label="Models directory" hint="Cubex checks free space on this folder's drive. It does not move models." placeholder="Largest drive" value={settings.local.modelsDir ?? ''} onChange={(v) => patch('local', { modelsDir: v })} />
      <NumRow label="Context size" hint="Tokens a local model can hold at once. Larger values use more memory." value={settings.local.contextSize} onChange={(v) => patch('local', { contextSize: v })} />
    </>
  )
}

export const section: SettingsSection = { id: 'local-ai', title: 'Local AI', page: 'local', order: 10, Component: LocalAiSettings }
