import { useEffect } from 'react'
import { useStore } from '../state/store'
import { api } from './api'

/**
 * The two things the main process needs from the window to notify well: which session is on screen
 * (so it stays quiet about that one) and where to go when a notification is clicked.
 */
export function useNotificationBridge(): void {
  const onScreen = useStore((state) => (state.view === 'chat' ? state.activeConversation?.id ?? null : null))

  useEffect(() => {
    // A failed report only means the next notification may be one the person did not need.
    api.setActiveConversation(onScreen).catch(() => undefined)
  }, [onScreen])

  useEffect(() => api.onOpenConversation((conversationId) => {
    void useStore.getState().openConversation(conversationId)
  }), [])
}
