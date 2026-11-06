import { loadUsers } from './users.mjs'

export function report(rows) {
  const users = loadUsers(rows)
  return users.map((user) => `${user.profile.name}: ${user.total}`).join('\n')
}
