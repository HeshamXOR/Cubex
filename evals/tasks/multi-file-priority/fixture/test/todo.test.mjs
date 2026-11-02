import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTodo, formatTodo } from '../src/todo.mjs'

test('a new todo is open', () => {
  assert.equal(createTodo(1, 'x').done, false)
})

test('formatTodo shows the box, the id and the text', () => {
  assert.match(formatTodo({ id: 3, text: 'Buy milk', done: false }), /^\[ \] 3 .*Buy milk$/)
  assert.match(formatTodo({ id: 4, text: 'Call Ann', done: true }), /^\[x\] 4 .*Call Ann$/)
})
