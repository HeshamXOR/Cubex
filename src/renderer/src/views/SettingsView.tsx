import { useStore } from '../state/store'
import type { AppSettings } from '../../../shared/settings'

export function SettingsView(): JSX.Element {
  const settings = useStore((s) => s.settings)
  const save = useStore((s) => s.saveSettings)
  if (!settings) return <div className="view"><div className="view__inner">Loading…</div></div>

  const patch = <K extends keyof AppSettings>(section: K, value: Partial<AppSettings[K]>): void => {
    void save({ [section]: { ...settings[section], ...value } } as Partial<AppSettings>)
  }
  const retry = (v: Partial<AppSettings['ai']['retry']>): void => patch('ai', { retry: { ...settings.ai.retry, ...v } })

  return (
    <div className="view">
      <div className="view__inner">
        <div className="view__title">Settings</div>
        <div className="view__sub">
          Telemetry is off by default and Cubex makes no outbound calls except to the providers you configure.
          Credentials are managed per-provider and encrypted by your OS keychain.
        </div>

        <Group title="General">
          <SelectRow label="Theme" value={settings.general.theme} options={[['dark', 'Dark'], ['light', 'Light'], ['system', 'System']]} onChange={(v) => patch('general', { theme: v as AppSettings['general']['theme'] })} />
          <ToggleRow label="Start maximized" on={settings.general.startMaximized} onChange={(v) => patch('general', { startMaximized: v })} />
        </Group>

        <Group title="AI defaults">
          <NumRow label="Max output tokens" value={settings.ai.maxOutputTokens} onChange={(v) => patch('ai', { maxOutputTokens: v })} />
          <ToggleRow label="Fallback routing" hint="Explicit opt-in — Cubex never switches providers silently" on={settings.ai.fallbackEnabled} onChange={(v) => patch('ai', { fallbackEnabled: v })} />
        </Group>

        <Group title="Retry engine">
          <ToggleRow label="Enable retries" on={settings.ai.retry.enabled} onChange={(v) => retry({ enabled: v })} />
          <NumRow label="Max attempts" value={settings.ai.retry.maxAttempts} onChange={(v) => retry({ maxAttempts: v })} />
          <NumRow label="Initial delay (ms)" value={settings.ai.retry.initialDelayMs} onChange={(v) => retry({ initialDelayMs: v })} />
          <NumRow label="Max delay (ms)" value={settings.ai.retry.maxDelayMs} onChange={(v) => retry({ maxDelayMs: v })} />
          <NumRow label="Backoff multiplier" step={0.5} value={settings.ai.retry.backoffMultiplier} onChange={(v) => retry({ backoffMultiplier: v })} />
          <SelectRow label="Jitter" value={settings.ai.retry.jitter} options={[['full', 'Full'], ['equal', 'Equal'], ['none', 'None']]} onChange={(v) => retry({ jitter: v as AppSettings['ai']['retry']['jitter'] })} />
          <ToggleRow label="Respect Retry-After header" on={settings.ai.retry.respectRetryAfter} onChange={(v) => retry({ respectRetryAfter: v })} />
          <ToggleRow label="Retry on 429 (rate limit)" on={settings.ai.retry.retryOn429} onChange={(v) => retry({ retryOn429: v })} />
          <ToggleRow label="Retry on timeout" on={settings.ai.retry.retryOnTimeout} onChange={(v) => retry({ retryOnTimeout: v })} />
          <SelectRow label="Unknown errors" value={settings.ai.retry.unknownErrorBehavior} options={[['fail', 'Fail (safe default)'], ['retry', 'Retry']]} onChange={(v) => retry({ unknownErrorBehavior: v as 'fail' | 'retry' })} />
        </Group>

        <Group title="Local AI">
          <TextRow label="Ollama base URL" value={settings.local.ollamaBaseUrl} onChange={(v) => patch('local', { ollamaBaseUrl: v })} />
          <TextRow label="Models directory" hint="Blank = app data dir" value={settings.local.modelsDir ?? ''} onChange={(v) => patch('local', { modelsDir: v })} />
          <NumRow label="Context size" value={settings.local.contextSize} onChange={(v) => patch('local', { contextSize: v })} />
          <ToggleRow label="GPU acceleration" on={settings.local.gpuAcceleration} onChange={(v) => patch('local', { gpuAcceleration: v })} />
          <NumRow label="Benchmark runs" value={settings.local.benchmarkRuns} onChange={(v) => patch('local', { benchmarkRuns: v })} />
        </Group>

        <Group title="Privacy">
          <ToggleRow label="Local Only mode" hint="Block all cloud APIs; use only local runtimes" on={settings.privacy.localOnly} onChange={(v) => patch('privacy', { localOnly: v })} />
          <ToggleRow label="Local logging" hint="Structured logs stored on disk (secrets always redacted)" on={settings.privacy.localLogging} onChange={(v) => patch('privacy', { localLogging: v })} />
          <ToggleRow label="Telemetry" hint="Off by default" on={settings.privacy.telemetry} onChange={(v) => patch('privacy', { telemetry: v })} />
        </Group>

        <Group title="Developer">
          <ToggleRow label="Debug mode" on={settings.developer.debugMode} onChange={(v) => patch('developer', { debugMode: v })} />
          <ToggleRow label="Raw request logging" hint="Redacted before writing" on={settings.developer.rawRequestLogging} onChange={(v) => patch('developer', { rawRequestLogging: v })} />
          <TextRow label="Proxy URL" value={settings.developer.proxyUrl ?? ''} onChange={(v) => patch('developer', { proxyUrl: v })} />
        </Group>
      </div>
    </div>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ fontWeight: 650, marginBottom: 6 }}>{title}</div>
      <div>{children}</div>
    </div>
  )
}

function RowShell({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="field" style={{ padding: '11px 0', borderBottom: '1px solid var(--border-soft)' }}>
      <div>
        <div style={{ color: 'var(--text-0)' }}>{label}</div>
        {hint && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{hint}</div>}
      </div>
      {children}
    </div>
  )
}

function ToggleRow({ label, hint, on, onChange }: { label: string; hint?: string; on: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <RowShell label={label} hint={hint}>
      <button className={`switch ${on ? 'switch--on' : ''}`} onClick={() => onChange(!on)} aria-pressed={on} />
    </RowShell>
  )
}

function NumRow({ label, hint, value, step, onChange }: { label: string; hint?: string; value: number; step?: number; onChange: (v: number) => void }): JSX.Element {
  return (
    <RowShell label={label} hint={hint}>
      <input className="numbox" type="number" step={step ?? 1} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </RowShell>
  )
}

function TextRow({ label, hint, value, onChange }: { label: string; hint?: string; value: string; onChange: (v: string) => void }): JSX.Element {
  return (
    <RowShell label={label} hint={hint}>
      <input className="input" style={{ width: 300 }} value={value} onChange={(e) => onChange(e.target.value)} />
    </RowShell>
  )
}

function SelectRow({ label, hint, value, options, onChange }: { label: string; hint?: string; value: string; options: Array<[string, string]>; onChange: (v: string) => void }): JSX.Element {
  return (
    <RowShell label={label} hint={hint}>
      <select className="select" value={value} onChange={(e) => onChange(e.target.value)} style={{ width: 180 }}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>{l}</option>
        ))}
      </select>
    </RowShell>
  )
}
