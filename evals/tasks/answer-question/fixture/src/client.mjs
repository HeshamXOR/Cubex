import { TIMEOUT_MS } from './config.mjs'
import { withRetries } from './retry.mjs'

export async function get(url, fetchImpl = fetch) {
  return withRetries(async () => {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (response.status >= 500) throw new Error(`server error ${response.status}`)
    return response
  })
}
