import type { TodoItem } from '@shared/ipc'

/**
 * What the agent was doing, kept per conversation while the app runs, so a summary can end with a short
 * note naming it: the todo list, the files read and edited, and the active plan. A summary describes the
 * past in prose; this part is the working state that has to be exact after the older turns are gone.
 */

export const WORKING_SET_MAX_FILES = 30
export const WORKING_SET_MAX_CHARS = 1_500

const TODO_LABEL: Record<TodoItem['status'], string> = { pending: 'pending', in_progress: 'in progress', completed: 'done' }
const HEAD = 'Working set when this summary was made (added by Cubex; files newest first):'

interface FileNote { read: boolean; edited: boolean; at: number }
interface State {
  todos: TodoItem[]
  files: Map<string, FileNote>
  plan?: { title?: string; plan: string }
  clock: number
}

const clip = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 3)}...` : flat
}

/** `label: a, b, c` with as many paths as fit in `room` characters, and a count of the rest. */
function pathLine(label: string, paths: string[], room: number): string | undefined {
  const kept: string[] = []
  let length = label.length + 2
  for (const path of paths) {
    const cost = path.length + 2
    if (length + cost > room) break
    kept.push(path)
    length += cost
  }
  if (!kept.length) return undefined
  const rest = paths.length - kept.length
  return `${label}: ${kept.join(', ')}${rest > 0 ? ` (+${rest} more)` : ''}`
}

export class WorkingSetTracker {
  private readonly states = new Map<string, State>()

  private state(conversationId: string): State {
    let state = this.states.get(conversationId)
    if (!state) {
      state = { todos: [], files: new Map(), clock: 0 }
      this.states.set(conversationId, state)
    }
    return state
  }

  setTodos(conversationId: string, todos: readonly TodoItem[]): void {
    this.state(conversationId).todos = todos.map((todo) => ({ ...todo }))
  }

  noteRead(conversationId: string, path: string): void {
    this.touch(conversationId, path, 'read')
  }

  noteEdit(conversationId: string, path: string): void {
    this.touch(conversationId, path, 'edited')
  }

  setPlan(conversationId: string, plan: string, title?: string): void {
    this.state(conversationId).plan = { plan, ...(title ? { title } : {}) }
  }

  forget(conversationId: string): void {
    this.states.delete(conversationId)
  }

  private touch(conversationId: string, path: string, kind: 'read' | 'edited'): void {
    const clean = path.trim()
    if (!clean) return
    const state = this.state(conversationId)
    const previous = state.files.get(clean)
    state.files.set(clean, {
      read: (previous?.read ?? false) || kind === 'read',
      edited: (previous?.edited ?? false) || kind === 'edited',
      at: ++state.clock
    })
  }

  /** The note to append to a summary, or undefined when there is nothing to say. At most 1,500 characters. */
  render(conversationId: string): string | undefined {
    const state = this.states.get(conversationId)
    if (!state) return undefined
    const newest = [...state.files.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, WORKING_SET_MAX_FILES)
    const edited = newest.filter(([, note]) => note.edited).map(([path]) => path)
    const read = newest.filter(([, note]) => !note.edited).map(([path]) => path)
    const todos = state.todos.slice(0, 12).map((todo) => `- [${TODO_LABEL[todo.status]}] ${clip(todo.content, 90)}`)
    const plan = state.plan ? `Active plan: ${clip(state.plan.title ?? state.plan.plan, 160)}` : undefined
    if (!todos.length && !edited.length && !read.length && !plan) return undefined

    const lines = [HEAD]
    if (todos.length) lines.push('Todo list:', ...todos)
    if (plan) lines.push(plan)
    // The file lists take what the todos and plan left, edited files first.
    let room = WORKING_SET_MAX_CHARS - lines.join('\n').length - 1
    for (const [label, paths] of [['Files edited', edited], ['Files read', read]] as const) {
      const line = pathLine(label, paths, room - 1)
      if (!line) continue
      lines.push(line)
      room -= line.length + 1
    }
    const text = lines.join('\n')
    return text.length > WORKING_SET_MAX_CHARS ? `${text.slice(0, WORKING_SET_MAX_CHARS - 3)}...` : text
  }
}
