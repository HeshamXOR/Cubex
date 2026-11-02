import { useEffect, useMemo } from 'react'
import type { HarnessProfileSetting, ReviewerSettings } from '../../../../../shared/settings'
import { selectableProvider, useStore } from '../../../state/store'
import type { SettingsSection } from '../registry'
import { RowShell, SelectRow, ToggleRow } from '../rows'
import { useSettingsEditor } from '../useSettingsEditor'

function HarnessProfile(): JSX.Element | null {
  const editor = useSettingsEditor()
  if (!editor) return null
  const { settings, patch } = editor
  return (
    <SelectRow
      label="Tools and instructions"
      hint="Auto gives small and open models (DeepSeek, Qwen, Llama and local models) fewer tools and a shorter prompt. Applies from your next message."
      value={settings.ai.harnessProfile ?? 'auto'}
      options={[['auto', 'Auto'], ['full', 'Full for all models'], ['lean', 'Lean for all models']]}
      onChange={(value) => patch('ai', { harnessProfile: value as HarnessProfileSetting })}
    />
  )
}

/** Which model reads the diff. Only shown while the reviewer is on. */
function ReviewerModel({ reviewer, onChange }: { reviewer: ReviewerSettings; onChange: (next: ReviewerSettings) => void }): JSX.Element {
  const settings = useStore((state) => state.settings)
  const providers = useStore((state) => state.providers)
  const models = useStore((state) => state.models)
  const loadModels = useStore((state) => state.loadModels)
  const usable = useMemo(() => providers.filter((provider) => selectableProvider(provider, settings)), [providers, settings])
  const providerId = reviewer.providerId ?? ''
  const model = reviewer.model ?? ''
  const listed = models[providerId] ?? []
  useEffect(() => {
    if (providerId && !models[providerId]) void loadModels(providerId).catch(() => undefined)
    // Only a newly chosen provider needs its list.
  }, [providerId])
  return (
    <>
      <SelectRow
        label="Reviewer provider"
        value={providerId}
        options={[['', 'Choose a provider'], ...usable.map((provider): [string, string] => [provider.id, provider.name])]}
        onChange={(next) => onChange({ ...reviewer, providerId: next, model: '' })}
      />
      <RowShell label="Reviewer model" hint={providerId ? 'It is asked a plain question about the task and the diff. It has no tools and cannot see your project.' : 'Choose a provider first.'}>
        {listed.length > 0
          ? (
            <select className="select" aria-label="Reviewer model" value={model} style={{ width: 180 }} onChange={(e) => onChange({ ...reviewer, model: e.target.value })}>
              <option value="">Choose a model</option>
              {model && !listed.some((entry) => entry.id === model) && <option value={model}>{model}</option>}
              {listed.map((entry) => <option key={entry.id} value={entry.id}>{entry.displayName || entry.id}</option>)}
            </select>
          )
          : <input className="input mono" aria-label="Reviewer model" style={{ width: 180 }} value={model} disabled={!providerId} placeholder="Model id" spellCheck={false} onChange={(e) => onChange({ ...reviewer, model: e.target.value })} />}
      </RowShell>
    </>
  )
}

function HarnessControls(): JSX.Element | null {
  const editor = useSettingsEditor()
  if (!editor) return null
  const reviewer: ReviewerSettings = editor.settings.ai.reviewer ?? { enabled: false }
  const change = (next: ReviewerSettings): void => editor.patch('ai', { reviewer: next })
  return (
    <>
      <HarnessProfile />
      <ToggleRow
        label="Review changes before finishing"
        hint="A second model reads the diff and can send fixes back once per turn. Its requests are billed."
        on={reviewer.enabled}
        onChange={(enabled) => change({ ...reviewer, enabled })}
      />
      {reviewer.enabled && <ReviewerModel reviewer={reviewer} onChange={change} />}
    </>
  )
}

export const section: SettingsSection = { id: 'harness', title: 'Agent tools', page: 'models', order: 85, Component: HarnessControls }
