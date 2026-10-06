import { useEffect } from 'react'
import { syncTasks, useRunningCount } from '../state/tasks'
import { useStore } from '../state/store'
import { ActivityGlyph } from '../theme/StateIcons'
import './panelTabs/tasks.css'

/**
 * "2 running" in the conversation header, shown only while a background task of this session runs.
 * It opens the Tasks tab; with nothing running there is nothing to show and it is not on screen.
 */
export function TasksIndicator(): JSX.Element | null {
  const conversationId = useStore((state) => state.activeConversation?.id)
  const showing = useStore((state) => state.panelOpen && state.panelTab === 'tasks')
  const running = useRunningCount(conversationId)

  // Events keep the count current; this reads what was already running when this session was opened.
  useEffect(() => {
    if (conversationId) void syncTasks(conversationId)
  }, [conversationId])

  if (running === 0) return null
  return (
    <button
      type="button"
      className={`chip chip--btn tasks-chip ${showing ? 'is-open' : ''}`}
      onClick={() => useStore.setState({ panelOpen: true, panelTab: 'tasks' })}
      aria-label={`${running} running. Show tasks`}
      title="Show running tasks"
    >
      <ActivityGlyph kind="running" active size={13} />
      <span>{running}<span className="chip__word">{' running'}</span></span>
    </button>
  )
}
