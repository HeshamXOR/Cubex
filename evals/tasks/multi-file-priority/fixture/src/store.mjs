import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export function load(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
}

export function save(file, todos) {
  writeFileSync(file, `${JSON.stringify(todos, null, 2)}\n`)
}
