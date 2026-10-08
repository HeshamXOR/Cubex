import type { AppSettings } from '../../../../../shared/settings'
import type { SettingsSection } from '../registry'
import { NumRow, SelectRow, ToggleRow } from '../rows'
import { useSettingsEditor } from '../useSettingsEditor'

function RetrySettings(): JSX.Element | null {
  const editor = useSettingsEditor()
  if (!editor) return null
  const { settings, patch } = editor
  const retry = (v: Partial<AppSettings['ai']['retry']>): void => patch('ai', { retry: { ...settings.ai.retry, ...v } })
  return (
    <>
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
    </>
  )
}

export const section: SettingsSection = { id: 'retry', title: 'Retry engine', page: 'models', order: 95, Component: RetrySettings }
