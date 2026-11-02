import { PRIORITIES, createTodo, formatTodo, sortTodos } from './todo.mjs'
import { load, save } from './store.mjs'

const file = process.env.TODO_FILE ?? 'todos.json'
const [command, ...rest] = process.argv.slice(2)
const todos = load(file)

function usage() {
  console.error('usage: cli.mjs add [--priority high|normal|low] <text> | list | done <id>')
  process.exit(2)
}

switch (command) {
  case 'add': {
    let priority = 'normal'
    const words = [...rest]
    const flag = words.indexOf('--priority')
    if (flag !== -1) {
      priority = words[flag + 1] ?? ''
      words.splice(flag, 2)
      if (!PRIORITIES.includes(priority)) {
        console.error(`unknown priority "${priority}" (use high, normal or low)`)
        process.exit(2)
      }
    }
    const text = words.join(' ').trim()
    if (!text) usage()
    const id = todos.reduce((max, todo) => Math.max(max, todo.id), 0) + 1
    todos.push(createTodo(id, text, priority))
    save(file, todos)
    console.log(`added ${id}`)
    break
  }
  case 'list':
    for (const todo of sortTodos(todos)) console.log(formatTodo(todo))
    break
  case 'done': {
    const todo = todos.find((item) => item.id === Number(rest[0]))
    if (!todo) {
      console.error(`no todo ${rest[0]}`)
      process.exit(1)
    }
    todo.done = true
    save(file, todos)
    console.log(`done ${todo.id}`)
    break
  }
  default:
    usage()
}
