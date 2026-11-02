import { RETRY } from './config.mjs'

/**
 * Milliseconds to wait before retry number `retry`, where 1 is the first retry (the second request).
 */
export function delayBefore(retry) {
  const wanted = RETRY.baseMs * RETRY.factor ** (retry - 1)
  return Math.min(wanted, RETRY.capMs)
}

export async function withRetries(send, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  let lastError
  for (let attempt = 1; attempt <= RETRY.maxAttempts; attempt++) {
    try {
      return await send(attempt)
    } catch (error) {
      lastError = error
      if (attempt < RETRY.maxAttempts) await sleep(delayBefore(attempt))
    }
  }
  throw lastError
}
