import { useStore } from '../state/store'
import type { AppSettings } from '../../../shared/settings'
import { SkillsLibrary } from '../components/SkillsLibrary'
import { Group, NumRow, RowShell, SelectRow, TextRow, ToggleRow } from './settings/rows'
import { closingSettingsSections, extraSettingsSections } from './settings/registry'

const ACCENTS = [
  { value: '#4f6cff', name: 'Blue' },
  { value: '#7b4dff', name: 'Violet' },
  { value: '#22c55e', name: 'Green' },
  { value: '#f59e0b', name: 'Amber' },
  { value: '#ef4444', name: 'Red' },
  { value: '#06b6d4', name: 'Cyan' },
  { value: '#ec4899', name: 'Pink' }
]

export function SettingsView(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const save = useStore((s) => s.saveSettings)
  const pickWorkspace = useStore((s) => s.pickWorkspace)
  const clearWorkspace = useStore((s) => s.clearWorkspace)
  if (!settings) return <div className="view"><div className="view__inner">Loading…</div></div>

  const patch = <K extends keyof AppSettings>(section: K, value: Partial<AppSettings[K]>): void => {
    void save({ [section]: { ...settings[section], ...value } } as Partial<AppSettings>)
  }
  const retry = (v: Partial<AppSettings['ai']['retry']>): void => patch('ai', { retry: { ...settings.ai.retry, ...v } })

  return (
    <div className="view settings">
      <div className="view__inner">
        <h1 className="view__title">Settings</h1>
        <p className="view__sub">
          Manage your workspace, appearance, model defaults and connected tools.
          Provider credentials are encrypted by your OS keychain.
        </p>

        <Group title="General">
          <SelectRow label="Theme" value={settings.general.theme} options={[['dark', 'Dark'], ['light', 'Light'], ['system', 'System']]} onChange={(v) => patch('general', { theme: v as AppSettings['general']['theme'] })} />
          <ToggleRow label="Start maximized" on={settings.general.startMaximized} onChange={(v) => patch('general', { startMaximized: v })} />
        </Group>

        <Group title="Appearance">
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
        </Group>

        <Group title="Workspace">
          <RowShell label="Working folder" hint={settings.general.workspacePath ?? 'No folder selected. Choose one so the model knows where your project is.'}>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn" onClick={() => void pickWorkspace()}>Choose folder</button>
              {settings.general.workspacePath && (
                <button className="btn btn--ghost" onClick={() => void clearWorkspace()}>Clear</button>
              )}
            </div>
          </RowShell>
        </Group>

        <Group title="Skills">
          <SkillsLibrary key={settings.general.workspacePath ?? ''} workspacePath={settings.general.workspacePath} />
        </Group>

        <Group title="AI defaults">
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
        </Group>

        <Group title="Retry engine">
          <ToggleRow label="Enable retries" on={settings.ai.retry.enabled} onChange={(v) => retry({ enabled: v })} />
          <NumRow label="Max attempts" value={settings.ai.retry.maxAttempts} onChange={(v) => retry({ maxAttempts: v })} />
          <NumRow label="Initial delay (ms)" value={settings.ai.retry.initialDelayMs} onChange={(v) => retry({ initialDelayMs: v })} />
          <NumRow label="Max delay (ms)" value={settings.ai.retry.maxDelayMs} onChange={(v) => retry({ maxDelayMs: v })} />
          <NumRow label="Backoff multiplier" step={0.5} value={settings.ai.retry.backoffMultiplier} onChange={(v) => retry({ backoffMultiplier: v })} />
          <SelectRow label="Jitter" value={settings.ai.retry.jitter} options={[['full', 'Full'], ['equal', 'Equal'], ['none', 'None']]} onChange={(v) => retry({ jitter: v as AppSettings['ai']['retry']['jitter'] })} />
          <ToggleRow label="Respect Retry-After header" on={settings.ai.retry.respectRetryAfter} onChange={(v) => retry({ respectRetryAfter: v })} />
          <ToggleRow label="Retry when rate limited (429)" on={settings.ai.retry.retryOn429} onChange={(v) => retry({ retryOn429: v })} />
          <ToggleRow label="Retry on timeout" on={settings.ai.retry.retryOnTimeout} onChange={(v) => retry({ retryOnTimeout: v })} />
          <SelectRow label="Unknown errors" hint="What to do when a failure is not one Cubex recognizes." value={settings.ai.retry.unknownErrorBehavior} options={[['fail', 'Stop and show the error'], ['retry', 'Retry']]} onChange={(v) => retry({ unknownErrorBehavior: v as 'fail' | 'retry' })} />
        </Group>

        <Group title="Local AI">
          <TextRow label="Ollama base URL" value={settings.local.ollamaBaseUrl} onChange={(v) => patch('local', { ollamaBaseUrl: v })} />
          <TextRow label="Models directory" hint="Cubex checks free space on this folder's drive. It does not move models." placeholder="Largest drive" value={settings.local.modelsDir ?? ''} onChange={(v) => patch('local', { modelsDir: v })} />
          <NumRow label="Context size" hint="Tokens a local model can hold at once. Larger values use more memory." value={settings.local.contextSize} onChange={(v) => patch('local', { contextSize: v })} />
        </Group>

        {extraSettingsSections.map(({ id, title, Component }) => (
          <Group key={id} id={id} title={title}>
            <Component />
          </Group>
        ))}

        <Group title="Privacy">
          <ToggleRow label="Local-only mode" hint="Use local model providers from the next request or retry. Does not block tools or downloads." on={settings.privacy.localOnly} onChange={(v) => patch('privacy', { localOnly: v })} />
          <ToggleRow label="Local logging" hint="Structured logs are kept on this PC, with secrets always redacted." on={settings.privacy.localLogging} onChange={(v) => patch('privacy', { localLogging: v })} />
        </Group>

        {closingSettingsSections.map(({ id, title, Component }) => (
          <Group key={id} id={id} title={title}>
            <Component />
          </Group>
        ))}
      </div>
    </div>
  )
}
