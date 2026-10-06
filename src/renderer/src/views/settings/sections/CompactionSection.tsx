import { useRef, useState, type CSSProperties } from 'react'
import { resolveCompactionPolicy, pruneStartsAt, MAX_COMPACTION_THRESHOLD, MIN_COMPACTION_THRESHOLD, DEFAULT_COMPACTION_THRESHOLD } from '@shared/contextPolicy'
import type { CompactionSettings } from '@shared/settings'
import { useStore } from '../../../state/store'
import type { SettingsSection } from '../registry'
import { RowShell, ToggleRow } from '../rows'
import './contextcost.css'

const percent = (share: number): number => Math.round(share * 100)
const SAVE_DELAY_MS = 300

function CompactionSettingsBody(): JSX.Element | null {
  const settings = useStore((state) => state.settings)
  const save = useStore((state) => state.saveSettings)
  const timer = useRef<number>()
  const [draft, setDraft] = useState<number>()
  const [error, setError] = useState<string>()
  if (!settings) return null

  const policy = resolveCompactionPolicy(settings.ai)
  const threshold = draft ?? percent(policy.threshold)
  const change = (value: Partial<CompactionSettings>): void => {
    setError(undefined)
    save({ ai: { ...settings.ai, compaction: { ...settings.ai.compaction, ...value } } })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
  }
  // A drag fires a change for every step; the setting is saved once it settles.
  const slide = (value: number): void => {
    setDraft(value)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => { change({ threshold: value / 100 }); setDraft(undefined) }, SAVE_DELAY_MS)
  }
  const pruneAt = percent(pruneStartsAt(threshold / 100))
  const fill = ((threshold - percent(MIN_COMPACTION_THRESHOLD)) / (percent(MAX_COMPACTION_THRESHOLD) - percent(MIN_COMPACTION_THRESHOLD))) * 100

  return (
    <div className="ctxsec">
      <p className="setgroup__note">Long conversations are kept inside the model's window by replacing older messages with a short summary. The full transcript always stays saved, and you can restore it from the thread. A change applies from your next message.</p>
      <ToggleRow
        label="Summarize automatically"
        hint={policy.auto
          ? 'When a request reaches the point below, older messages are summarized before it is sent.'
          : 'Nothing is summarized until you ask. A conversation that outgrows the window fails with a context length error.'}
        on={policy.auto}
        onChange={(value) => change({ auto: value })}
      />
      <RowShell label="Summarize at" hint={policy.auto
        ? `Share of the input budget. ${percent(DEFAULT_COMPACTION_THRESHOLD)}% is the default; lower summarizes sooner and leaves more room for the reply.`
        : 'Turn on automatic summarizing to choose this.'}>
        <div className="ctxsec__slider">
          <input
            type="range"
            className="slider"
            min={percent(MIN_COMPACTION_THRESHOLD)}
            max={percent(MAX_COMPACTION_THRESHOLD)}
            step={5}
            value={threshold}
            disabled={!policy.auto}
            aria-label="Summarize at"
            aria-valuetext={`${threshold} percent of the input budget`}
            style={{ '--p': `${fill}%` } as CSSProperties}
            onChange={(event) => slide(Number(event.target.value))}
          />
          <output className="ctxsec__value" aria-hidden="true">{threshold}%</output>
        </div>
      </RowShell>
      <ToggleRow
        label="Trim old tool output"
        hint={`While a task runs, output from earlier tool calls is replaced by short stubs once a request passes ${pruneAt}% of the input budget. The model can run a tool again if it needs the output.`}
        on={policy.prune}
        onChange={(value) => change({ prune: value })}
      />
      {error && <p className="callout callout--error" role="alert"><span className="callout__body">Could not save this setting. {error}</span></p>}
    </div>
  )
}

export const section: SettingsSection = { id: 'compaction', title: 'Summarizing', order: 200, Component: CompactionSettingsBody }
