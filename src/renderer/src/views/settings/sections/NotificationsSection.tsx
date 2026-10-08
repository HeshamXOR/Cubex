import { useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { DEFAULT_NOTIFICATIONS, type NotificationSettings } from '../../../../../shared/settings'
import { api } from '../../../lib/api'
import { useStore } from '../../../state/store'
import type { SettingsSection } from '../registry'
import { RowShell, Switch } from '../rows'
import './notifications.css'

type Test = { phase: 'idle' } | { phase: 'sending' } | { phase: 'sent' } | { phase: 'blocked'; reason: string }

const TEST_HINT = 'Shows one now, whatever the switches above say, so you can see how your system treats it.'
const SENT_HINT = 'Sent. If nothing showed up, check your system notification settings and focus mode.'

/** Like ToggleRow, with a way to dim the switches that mean nothing while notifications are off. */
function SwitchRow({ label, hint, on, disabled, onChange }: { label: string; hint: string; on: boolean; disabled?: boolean; onChange: (next: boolean) => void }): JSX.Element {
  return (
    <RowShell label={label} hint={hint}>
      <Switch label={label} on={on} disabled={disabled} onChange={onChange} />
    </RowShell>
  )
}

function NotificationSettingsGroup(): JSX.Element {
  const stored = useStore((state) => state.settings?.notifications)
  const save = useStore((state) => state.saveSettings)
  const [test, setTest] = useState<Test>({ phase: 'idle' })
  const current: NotificationSettings = { ...DEFAULT_NOTIFICATIONS, ...stored }
  const off = !current.enabled

  const set = (change: Partial<NotificationSettings>): void => {
    void save({ notifications: { ...current, ...change } })
  }

  const sendTest = async (): Promise<void> => {
    setTest({ phase: 'sending' })
    try {
      const result = await api.sendTestNotification()
      setTest(result.shown ? { phase: 'sent' } : { phase: 'blocked', reason: result.reason ?? 'The system did not allow it.' })
    } catch (reason) {
      setTest({ phase: 'blocked', reason: reason instanceof Error ? reason.message : String(reason) })
    }
  }

  return (
    <div className="notifsec">
      <p className="setgroup__note">Cubex can tell you when a session needs you or ends while you are somewhere else. Clicking a notification opens that session.</p>
      <SwitchRow
        label="Show notifications"
        hint="Off means no notification, no flashing taskbar button and no badge on the Cubex icon."
        on={current.enabled}
        onChange={(next) => set({ enabled: next })}
      />
      <SwitchRow
        label="A session needs me"
        hint="It is waiting for an approval, an answer or a plan review. The taskbar button flashes and shows a badge until you are back."
        on={current.needsMe}
        disabled={off}
        onChange={(next) => set({ needsMe: next })}
      />
      <SwitchRow
        label="A session finished"
        hint="A turn ended and the answer is ready."
        on={current.finished}
        disabled={off}
        onChange={(next) => set({ finished: next })}
      />
      <SwitchRow
        label="A session failed"
        hint="A turn stopped with an error. Stopping a turn yourself never notifies."
        on={current.failed}
        disabled={off}
        onChange={(next) => set({ failed: next })}
      />
      <SwitchRow
        label="Only when Cubex is in the background"
        hint="Stay quiet while Cubex is the window in front. Turn this off to hear about your other sessions while you work in one. The session on screen never notifies."
        on={current.onlyInBackground}
        disabled={off}
        onChange={(next) => set({ onlyInBackground: next })}
      />
      <SwitchRow
        label="Play a sound"
        hint="Use the notification sound of your system."
        on={current.sound}
        disabled={off}
        onChange={(next) => set({ sound: next })}
      />
      <RowShell label="Test notification" hint={test.phase === 'sent' ? SENT_HINT : TEST_HINT}>
        <button type="button" className="btn btn--sm" onClick={() => void sendTest()} disabled={test.phase === 'sending'}>
          {test.phase === 'sending' ? 'Sending' : 'Send a test'}
        </button>
      </RowShell>
      <div className="sr-only" role="status">{test.phase === 'sent' ? SENT_HINT : ''}</div>
      {test.phase === 'blocked' && (
        <p className="callout callout--warn" role="alert">
          <TriangleAlert size={14} aria-hidden="true" />
          <span className="callout__body">Could not show a notification. {test.reason}</span>
        </p>
      )}
    </div>
  )
}

export const section: SettingsSection = { id: 'notifications', title: 'Notifications', page: 'notifications', order: 400, Component: NotificationSettingsGroup }
