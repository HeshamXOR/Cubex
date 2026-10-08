import type { AppSettings } from '../../../../../shared/settings'
import type { SettingsSection } from '../registry'
import { RowShell, SelectRow } from '../rows'
import { useSettingsEditor } from '../useSettingsEditor'

const ACCENTS = [
  { value: '#4f6cff', name: 'Blue' },
  { value: '#7b4dff', name: 'Violet' },
  { value: '#22c55e', name: 'Green' },
  { value: '#f59e0b', name: 'Amber' },
  { value: '#ef4444', name: 'Red' },
  { value: '#06b6d4', name: 'Cyan' },
  { value: '#ec4899', name: 'Pink' }
]

function AppearanceSettings(): JSX.Element | null {
  const editor = useSettingsEditor()
  if (!editor) return null
  const { settings, patch } = editor
  return (
    <>
      <SelectRow label="Theme" value={settings.general.theme} options={[['dark', 'Dark'], ['light', 'Light'], ['system', 'System']]} onChange={(v) => patch('general', { theme: v as AppSettings['general']['theme'] })} />
      <RowShell label="Accent color" hint="Used for focus, selection and progress">
        <div className="row swatches">
          {ACCENTS.map((accent) => {
            const selected = settings.appearance.accent.toLowerCase() === accent.value
            return (
              <button
                key={accent.value}
                onClick={() => patch('appearance', { accent: accent.value })}
                title={accent.name}
                aria-label={`${accent.name} accent`}
                aria-pressed={selected}
                data-selected={selected}
                className="swatch"
                style={{ background: accent.value }}
              />
            )
          })}
          <input
            type="color"
            className="swatch swatch--input"
            value={settings.appearance.accent}
            data-selected={!ACCENTS.some((accent) => accent.value === settings.appearance.accent.toLowerCase())}
            onChange={(e) => patch('appearance', { accent: e.target.value })}
            title="Choose a custom color"
            aria-label="Custom accent color"
          />
        </div>
      </RowShell>
      <SelectRow label="Font" value={settings.appearance.font} options={[['system', 'System'], ['inter', 'Inter'], ['geist', 'Geist'], ['mono', 'Monospace']]} onChange={(v) => patch('appearance', { font: v as AppSettings['appearance']['font'] })} />
      <SelectRow label="Density" value={settings.appearance.density} options={[['comfortable', 'Comfortable'], ['compact', 'Compact']]} onChange={(v) => patch('appearance', { density: v as AppSettings['appearance']['density'] })} />
      <SelectRow label="Corners" value={settings.appearance.radius} options={[['sharp', 'Sharp'], ['default', 'Default'], ['round', 'Rounded']]} onChange={(v) => patch('appearance', { radius: v as AppSettings['appearance']['radius'] })} />
    </>
  )
}

export const section: SettingsSection = { id: 'appearance', title: 'Appearance', page: 'appearance', order: 10, Component: AppearanceSettings }
