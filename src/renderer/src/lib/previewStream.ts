import type { AIStreamEvent } from '@core/types'
import type { ChatEvent } from '../../../shared/ipc'
import { useStore, type LiveMessage } from '../state/store'

/**
 * Design-review only (browser preview, `?seed=1&stream=1`). Drives the real
 * store with the kind of events a provider sends: small text chunks cut at
 * arbitrary points, with uneven gaps between them. Never bundled into a code
 * path the packaged app takes.
 */

export const DEMO_REASONING =
  'The upload helper retries every failure at once, so a rate limit from the storage service turns into a burst of requests. ' +
  'I should read the Retry-After header when it is present, back off exponentially with jitter when it is not, and only retry the statuses that can recover.'

export const DEMO_REPLY = `I traced the upload path and found why large files stall: \`uploadChunk\` retries every failure immediately, so a **429** from the storage API turns into a burst of requests that keeps the limit tripped.

## What I changed

- Added a \`withBackoff\` helper with jitter, capped at 8 s
- \`UploadError\` now carries the status and the [\`Retry-After\` header](https://developer.mozilla.org/docs/Web/HTTP/Headers/Retry-After)
- Only 429 and 5xx responses are retried; other 4xx fail at once

The retry policy in numbers:

| Case | Before | After |
| --- | --- | --- |
| 429 with Retry-After | immediate retry | waits the header value |
| 503 | immediate retry | exponential, 250 ms base |
| 400 | retried 3 times | fails at once |

Here is the core of the helper:

\`\`\`ts
export async function withBackoff<T>(
  run: () => Promise<T>,
  delayFor: (error: unknown) => number | null,
  { retries = 4, baseMs = 250 } = {}
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      const hinted = delayFor(error)
      if (hinted === null || attempt >= retries) throw error
      const wait = hinted || Math.min(8000, baseMs * 2 ** attempt)
      await sleep(wait * (0.5 + Math.random() / 2))
    }
  }
}
\`\`\`

Run \`npm test -- upload\` to confirm the four new cases pass. If you would rather keep the old behavior for local development, set \`UPLOAD_RETRIES=0\` and the helper becomes a pass-through.`

export interface PreviewStreamOptions {
  text?: string
  reasoning?: string
  /** Characters per network chunk, [min, max]. */
  chunk?: [number, number]
  /** Milliseconds between chunks, [min, max]. */
  gap?: [number, number]
  /** Keep the message open after the last chunk, so the "still live" state can be reviewed. */
  hold?: boolean
}

const between = ([min, max]: [number, number]): number => min + Math.random() * (max - min)
const sleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms))

function chunks(text: string, size: [number, number]): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length;) {
    const length = Math.max(1, Math.round(between(size)))
    out.push(text.slice(i, i + length))
    i += length
  }
  return out
}

export async function runPreviewStream(options: PreviewStreamOptions = {}): Promise<void> {
  const emit = (window as unknown as { __emit?: (event: ChatEvent) => void }).__emit
  const owner = useStore.getState().activeConversation?.id
  if (!emit || !owner) return
  const { text = DEMO_REPLY, reasoning = DEMO_REASONING, chunk = [4, 38], gap = [30, 140], hold = false } = options

  const streamId = `preview-${Date.now()}`
  const assistant: LiveMessage = { id: `a-${streamId}`, role: 'assistant', text: '', blocks: [], createdAt: Date.now(), streaming: true }
  useStore.setState((s) => ({
    liveMessages: [...s.liveMessages, assistant],
    streamId,
    status: 'thinking',
    genStartedAt: Date.now(),
    streamOwners: { ...s.streamOwners, [streamId]: owner }
  }))

  let sequence = 0
  const send = (event: AIStreamEvent): void => emit({ streamId, kind: 'stream', event, sequence: sequence++ })
  send({ type: 'start', provider: 'anthropic', model: 'claude-opus-4-8', requestId: streamId })
  for (const piece of chunks(reasoning, [6, 22])) {
    send({ type: 'reasoning_delta', text: piece })
    await sleep(between([25, 90]))
  }
  for (const piece of chunks(text, chunk)) {
    send({ type: 'text_delta', text: piece })
    await sleep(between(gap))
  }
  if (hold) return
  send({
    type: 'completed',
    response: { id: streamId, provider: 'anthropic', model: 'claude-opus-4-8', content: [], text, toolCalls: [], stopReason: 'stop', createdAt: Date.now() }
  })
}
