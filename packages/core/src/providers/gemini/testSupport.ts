/**
 * Test support: recorded Gemini SSE fixtures and a fake `fetch` that replays them.
 * Not imported by production code. No network is ever touched.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { AIStreamEvent } from '../../types/stream'

/** The raw text of `fixtures/<name>.sse`. */
export function fixtureText(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}.sse`, import.meta.url)), 'utf8')
}

/** Each `data:` frame of a fixture, parsed. */
export function fixtureFrames(name: string): unknown[] {
  return fixtureText(name)
    .split(/\n\n/)
    .map((block) => block.trim())
    .filter((block) => block.startsWith('data: '))
    .map((block) => JSON.parse(block.slice('data: '.length)) as unknown)
}

/** An SSE response whose body arrives as the given chunks (split anywhere, even mid-frame). */
export function sseResponse(chunks: string[], init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const encoder = new TextEncoder()
  let next = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunks[next++]!))
    }
  })
  return new Response(body, { status: init.status ?? 200, headers: { 'content-type': 'text/event-stream', ...(init.headers ?? {}) } })
}

export function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }
  })
}

export interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
  signal?: AbortSignal | undefined
}

/** A fetch that records each request and answers from a queue (the last answer repeats). */
export function fakeFetch(...answers: Array<Response | ((call: RecordedCall) => Response | Promise<Response>)>): {
  fetch: typeof fetch
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value
    })
    const raw = typeof init?.body === 'string' ? init.body : undefined
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: raw ? (JSON.parse(raw) as unknown) : undefined,
      signal: init?.signal ?? undefined
    }
    calls.push(call)
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]
    if (!answer) throw new Error('fakeFetch: no answer configured')
    return typeof answer === 'function' ? answer(call) : answer.clone()
  }
  return { fetch: impl as typeof fetch, calls }
}

export async function collect(stream: AsyncIterable<AIStreamEvent>): Promise<AIStreamEvent[]> {
  const out: AIStreamEvent[] = []
  for await (const event of stream) out.push(event)
  return out
}
