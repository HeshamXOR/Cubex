import type { ExecutableTool, JSONValue, ToolResult } from '@core/types'
import type { TodoItem } from '@shared/ipc'

/**
 * `todo_write` — a Claude-Code-style task tracker. The model owns a single
 * checklist for the turn and rewrites the WHOLE list each call (not deltas),
 * marking exactly one item `in_progress`. It mutates no files, so it runs
 * without a permission prompt; the harness surfaces the list live via `onUpdate`.
 */
export function createTodoTool(onUpdate: (todos: TodoItem[]) => void): ExecutableTool {
  return {
    definition: {
      name: 'todo_write',
      description:
        'Record and update a checklist of tasks for a multi-step job. Pass the ENTIRE list every time ' +
        '(it replaces the previous list). Each item has `content` (imperative, e.g. "Add auth route"), ' +
        '`status` (pending | in_progress | completed), and optional `activeForm` (present continuous, e.g. ' +
        '"Adding auth route"). Keep exactly one item in_progress. Use it for tasks with 3+ steps so the user ' +
        'can follow progress; skip it for trivial single-step requests.',
      inputSchema: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                activeForm: { type: 'string' }
              },
              required: ['content', 'status']
            }
          }
        },
        required: ['todos']
      }
    },
    defaultPermission: 'allow',
    async execute(input: JSONValue): Promise<ToolResult> {
      const raw = (input as { todos?: unknown })?.todos
      if (!Array.isArray(raw)) {
        return { toolUseId: '', content: 'todo_write expects a `todos` array.', isError: true }
      }
      const todos: TodoItem[] = []
      for (const item of raw) {
        if (!item || typeof item !== 'object') continue
        const o = item as Record<string, unknown>
        const content = typeof o.content === 'string' ? o.content.trim() : ''
        if (!content) continue
        const status =
          o.status === 'in_progress' || o.status === 'completed' ? o.status : 'pending'
        todos.push({
          content,
          status,
          ...(typeof o.activeForm === 'string' && o.activeForm ? { activeForm: o.activeForm } : {})
        })
      }
      onUpdate(todos)
      const done = todos.filter((t) => t.status === 'completed').length
      return { toolUseId: '', content: `Todo list updated — ${done}/${todos.length} complete.` }
    }
  }
}
