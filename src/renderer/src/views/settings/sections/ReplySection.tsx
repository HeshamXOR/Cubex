import type { SettingsSection } from '../registry'
import { RowShell } from '../rows'
import { useSettingsEditor } from '../useSettingsEditor'

function ReplyLength(): JSX.Element | null {
  const editor = useSettingsEditor()
  if (!editor) return null
  const { settings, patch } = editor
  return (
    <RowShell label="Max output tokens" hint="Leave empty for Automatic: up to 32,000 tokens per reply, or what the model can write if that is less. A low limit cuts long files and tool calls off.">
      <input
        className="numbox"
        type="number"
        min={1}
        aria-label="Max output tokens"
        placeholder="Auto"
        value={settings.ai.maxOutputTokens > 0 ? settings.ai.maxOutputTokens : ''}
        onChange={(event) => patch('ai', { maxOutputTokens: event.target.value === '' ? 0 : Math.max(1, Math.floor(Number(event.target.value)) || 0) })}
      />
    </RowShell>
  )
}

export const section: SettingsSection = { id: 'reply', title: 'Reply length', page: 'models', order: 80, Component: ReplyLength }
