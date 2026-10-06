import { useStore } from '../state/store'
import { activitySpecFor } from '../status/StatusIndicator'

/**
 * True while a turn is working or waiting on the person. Components subscribe to
 * the boolean, so they re-render only when it flips, not on every status update.
 */
export function useBusy(): boolean {
  return useStore((s) => !!activitySpecFor(s.status).active || s.status === 'awaiting_input')
}
