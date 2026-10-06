import { useEffect } from 'react'
import { SquareTerminal } from 'lucide-react'
import { runningCount, sortTasks } from '../../lib/taskModel'
import { useNow } from '../../lib/useNow'
import { syncTasks, useConversationTasks, useRunningCount } from '../../state/tasks'
import { useStore } from '../../state/store'
import { TaskRow } from './TaskRow'
import type { PanelTabDef } from './registry'
import './tasks.css'

/** How often the list is re-read as a fallback; the main process's own events normally make it current. */
const FALLBACK_POLL_MS = 5000

function TasksTab(): JSX.Element {
  const conversationId = useStore((state) => state.activeConversation?.id)
  const tasks = useConversationTasks(conversationId)
  const running = runningCount(tasks)
  const now = useNow(running > 0)

  useEffect(() => {
    if (!conversationId) return
    void syncTasks(conversationId)
    const timer = window.setInterval(() => { if (!document.hidden) void syncTasks(conversationId) }, FALLBACK_POLL_MS)
    const onFocus = (): void => void syncTasks(conversationId)
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [conversationId])

  if (tasks.length === 0) {
    return (
      <div className="rev-empty">
        <SquareTerminal size={22} strokeWidth={1.5} aria-hidden="true" />
        <h2>No background tasks</h2>
        <p>A dev server, watcher or long test run that Cubex starts in the background shows up here. You can watch its output, send it input and stop it.</p>
      </div>
    )
  }

  const finished = tasks.length - running
  return (
    <div className="tasks">
      <div className="tasks__bar">
        <span>{running > 0 ? `${running} running` : 'Nothing running'}</span>
        {finished > 0 && <span className="tasks__quiet">{finished} finished</span>}
      </div>
      <ul className="tasks__list" aria-label="Background tasks">
        {sortTasks(tasks).map((task) => <TaskRow key={task.id} task={task} now={now} defaultOpen={tasks.length === 1} />)}
      </ul>
    </div>
  )
}

/** Shown once the session has had a background task, so the tab never advertises an empty list. */
function useVisible(): boolean {
  const conversationId = useStore((state) => state.activeConversation?.id)
  return useConversationTasks(conversationId).length > 0
}

function useBadge(): number | undefined {
  const conversationId = useStore((state) => state.activeConversation?.id)
  const count = useRunningCount(conversationId)
  return count > 0 ? count : undefined
}

export const tab: PanelTabDef = { id: 'tasks', label: 'Tasks', order: 10, Component: TasksTab, useVisible, useBadge }
