import { normalize } from './normalize.mjs'

export function loadUsers(rows) {
  const byId = new Map()
  for (const row of rows.map(normalize)) {
    const user = byId.get(row.id) ?? { id: row.id, profile: row.profile, total: 0 }
    user.total += row.amount
    byId.set(row.id, user)
  }
  return [...byId.values()]
}
