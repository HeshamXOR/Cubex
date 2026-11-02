export function createTodo(id, text) {
  return { id, text, done: false }
}

export function formatTodo(todo) {
  return `[${todo.done ? 'x' : ' '}] ${todo.id} ${todo.text}`
}
