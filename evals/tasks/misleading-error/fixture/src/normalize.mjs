import { parseProfile } from './profile.mjs'

export function normalize(row) {
  return { id: row.user_id, amount: Number(row.amount), profile: parseProfile(row.profile_json) }
}
