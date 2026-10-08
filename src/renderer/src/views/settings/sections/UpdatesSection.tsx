import { TriangleAlert } from 'lucide-react'
import { UpdateCard } from '../../../components/UpdateNotice'
import { useNow } from '../../../lib/useNow'
import { statusText } from '../../../lib/updateText'
import { useStore } from '../../../state/store'
import { useUpdates } from '../../../state/updates'
import { openSettingsPage } from '../../../lib/settingsLink'
import type { SettingsSection } from '../registry'
import { ToggleRow } from '../rows'
import './updates.css'

/** What a screen reader hears when a look ends. It leaves out the age of the look, which changes every minute. */
function liveText(state: ReturnType<typeof useUpdates.getState>['state']): string {
  if (state.check.status === 'checking') return 'Checking for updates.'
  if (state.check.status === 'failed') return state.check.error ?? 'The check did not work.'
  if (state.check.status === 'done') return state.update ? `Cubex ${state.update.info.version} is available.` : 'Cubex is up to date.'
  return ''
}

function UpdatesSettings(): JSX.Element | null {
  const settings = useStore((store) => store.settings)
  const save = useStore((store) => store.saveSettings)
  const state = useUpdates((store) => store.state)
  const loaded = useUpdates((store) => store.loaded)
  const pending = useUpdates((store) => store.pending)
  const problem = useUpdates((store) => store.problem)
  const check = useUpdates((store) => store.check)
  const now = useNow(true, 30_000)
  if (!settings) return null

  const localOnly = settings.privacy.localOnly
  const checking = state.check.status === 'checking' || pending === 'check'
  const busyWithFile = state.update?.stage === 'downloading' || state.update?.stage === 'installing'
  const failure = state.check.status === 'failed' ? state.check.error : undefined

  return (
    <div className="updset">
      <dl className="updset__facts" aria-label="Updates">
        <div className="updset__row">
          <dt>Version</dt>
          <dd>{loaded ? state.currentVersion || 'Unknown' : '—'}</dd>
        </div>
        <div className="updset__row">
          <dt>Status</dt>
          <dd className="updset__status">
            <span>{loaded ? statusText(state, now) : 'Reading the update state…'}</span>
            <button type="button" className="btn btn--sm" disabled={checking || busyWithFile || localOnly || !loaded} onClick={() => void check()}>
              {checking ? 'Checking…' : 'Check for updates'}
            </button>
          </dd>
        </div>
      </dl>
      <div className="sr-only" role="status">{liveText(state)}</div>

      {localOnly && (
        <p className="setgroup__note">
          Local-only mode is on, so Cubex does not look for updates.{' '}
          <button type="button" className="updset__link" onClick={() => openSettingsPage('privacy')}>Turn it off in Privacy</button> to check.
        </p>
      )}

      {failure && !localOnly && (
        <div className="callout callout--warn" role="alert">
          <TriangleAlert size={14} aria-hidden="true" />
          <div className="callout__body">{failure}</div>
        </div>
      )}
      {problem && (
        <div className="callout callout--warn" role="alert">
          <TriangleAlert size={14} aria-hidden="true" />
          <div className="callout__body">{problem}</div>
        </div>
      )}

      {state.update && <UpdateCard update={state.update} placement="page" />}

      {!state.canInstall && loaded && <p className="setgroup__note">{state.cannotInstallReason}</p>}

      <ToggleRow
        label="Check automatically"
        hint="Cubex asks GitHub for the latest release about every 6 hours, sending only its version number."
        on={settings.updates?.auto ?? true}
        disabled={localOnly}
        onChange={(auto) => void save({ updates: { auto } })}
      />
    </div>
  )
}

export const section: SettingsSection = { id: 'updates', title: 'Updates', page: 'updates', order: 600, Component: UpdatesSettings }
