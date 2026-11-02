import { createTodo, formatTodo } from './todo.mjs'
import { load, save } from './store.mjs'

const file = process.env.TODO_FILE ?? 'todos.json'
const [command, ...rest] = process.argv.slice(2)
const todos = load(file)

function usage() {
  console.error('usage: cli.mjs add <text> | list | done <id>')
  process.exit(2)
}

switch (command) {
  case 'add': {
    const text = rest.join(' ').trim()
    if (!text) usage()
    const id = todos.reduce((max, todo) => Math.max(max, todo.id), 0) + 1
    todos.push(createTodo(id, text))
    save(file, todos)
    console.log(`added ${id}`)
    break
  }
  case 'list':
    for (const todo of todos) console.log(formatTodo(todo))
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
