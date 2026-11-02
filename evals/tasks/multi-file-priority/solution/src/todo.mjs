export const PRIORITIES = ['high', 'normal', 'low']

export function createTodo(id, text, priority = 'normal') {
  return { id, text, done: false, priority }
}

export function priorityOf(todo) {
  return PRIORITIES.includes(todo.priority) ? todo.priority : 'normal'
}

export function formatTodo(todo) {
  return `[${todo.done ? 'x' : ' '}] ${todo.id} (${priorityOf(todo)}) ${todo.text}`
}

/** Ordered high, normal, low; by id inside one priority. */
export function sortTodos(todos) {
  return [...todos].sort((a, b) => PRIORITIES.indexOf(priorityOf(a)) - PRIORITIES.indexOf(priorityOf(b)) || a.id - b.id)
}
