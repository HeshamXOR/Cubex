/** Rows store the profile as JSON. Older rows wrapped it in a "data" field. */
export function parseProfile(text) {
  const parsed = JSON.parse(text)
  return parsed.profile
}
