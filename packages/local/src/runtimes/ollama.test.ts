import { afterEach, describe, expect, it, vi } from 'vitest'
import { OllamaRuntime } from './OllamaRuntime'
import type { PullProgressUpdate } from './LocalRuntime'

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response
}

function ndjsonStreamResponse(lines: string[]): Response {
  const encoder = new TextEncoder()
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= lines.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(lines[i] + '\n'))
      i++
    }
  })
  return { ok: true, status: 200, body } as unknown as Response
}

afterEach(() => vi.restoreAllMocks())

describe('OllamaRuntime.detect', () => {
  it('reports running when /api/version responds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ version: '0.5.1' })))
    const det = await new OllamaRuntime().detect()
    expect(det).toMatchObject({ installed: true, running: true, version: '0.5.1' })
  })

  it('reports not reachable on network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }))
    const det = await new OllamaRuntime().detect()
    expect(det.running).toBe(false)
    expect(det.error).toMatch(/not reachable/i)
  })
})

describe('OllamaRuntime.listModels', () => {
  it('parses /api/tags into model entries', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({
        models: [
          {
            name: 'llama3.1:8b',
            size: 4_700_000_000,
            details: { family: 'llama', parameter_size: '8B', quantization_level: 'Q4_K_M' }
          }
        ]
      })
    ))
    const models = await new OllamaRuntime().listModels()
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      id: 'llama3.1:8b',
      runtime: 'ollama',
      parameterCount: 8,
      quantization: 'Q4_K_M',
      family: 'llama'
    })
  })
})

describe('OllamaRuntime.pull', () => {
  it('reports increasing progress from NDJSON and completes', async () => {
    const lines = [
      JSON.stringify({ status: 'pulling', total: 1000, completed: 250 }),
      JSON.stringify({ status: 'pulling', total: 1000, completed: 500 }),
      JSON.stringify({ status: 'pulling', total: 1000, completed: 1000 })
    ]
    vi.stubGlobal('fetch', vi.fn(async () => ndjsonStreamResponse(lines)))
    const updates: PullProgressUpdate[] = []
    await new OllamaRuntime().pull('llama3.1:8b', (p) => updates.push(p))
    const completedValues = updates.filter((u) => u.completedBytes !== undefined).map((u) => u.completedBytes!)
    expect(completedValues).toEqual([250, 500, 1000])
    expect(updates.at(-1)).toMatchObject({ done: true, status: 'success' })
  })
})
