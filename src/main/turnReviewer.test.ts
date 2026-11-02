import { describe, expect, it, vi } from 'vitest'
import type { AIRequest, AIResponse } from '@core/types'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { parseReview, reviewTurn, reviewerTarget, truncateDiff } from './turnReviewer'

const reply = (text: string, usage?: AIResponse['usage']): AIResponse => ({
  id: 'r1', provider: 'p', model: 'm', content: [{ type: 'text', text }], text, toolCalls: [], stopReason: 'stop', createdAt: 0, usage
})

const input = { task: 'Make parseDate accept ISO week dates', diff: 'diff --git a/src/date.ts b/src/date.ts\n@@ -1 +1 @@\n-a\n+b\n', finalText: 'Done.' }

describe('parseReview', () => {
  it('reads fenced JSON', () => {
    const result = parseReview('```json\n{"verdict":"revise","feedback":"1. src/date.ts: week 53 is rejected.\\n2. src/date.ts: no handling of 2020-W00."}\n```')
    expect(result.verdict).toBe('revise')
    expect(result.feedback).toContain('week 53')
  })

  it('finds JSON inside prose, even with braces before it', () => {
    const result = parseReview('Looking at the diff {briefly}, here is my answer:\n{"verdict": "revise", "feedback": ["src/a.ts: off by one in the loop", "2) src/b.ts: unrelated edit"]}\nHope that helps.')
    expect(result).toEqual({ verdict: 'revise', feedback: '1. src/a.ts: off by one in the loop\n2) src/b.ts: unrelated edit' })
  })

  it('approves on approve, garbage, an unknown verdict, or revise with nothing to fix', () => {
    expect(parseReview('{"verdict":"approve","feedback":""}').verdict).toBe('approve')
    expect(parseReview('The change looks fine to me.').verdict).toBe('approve')
    expect(parseReview('{"verdict": "revise", "feedback": ').verdict).toBe('approve')
    expect(parseReview('{"verdict":"maybe","feedback":"x"}').verdict).toBe('approve')
    expect(parseReview('{"verdict":"revise","feedback":"  "}')).toEqual({ verdict: 'approve', feedback: '' })
  })
})

describe('truncateDiff', () => {
  const hunk = (n: number): string => `@@ -${n},1 +${n},1 @@\n-old ${n}\n+new ${n}${'x'.repeat(100)}\n`
  const file = (name: string, hunks: number): string => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n${Array.from({ length: hunks }, (_, i) => hunk(i + 1)).join('')}`

  it('leaves a diff that fits alone', () => {
    expect(truncateDiff(file('a.ts', 1), 10_000)).toBe(file('a.ts', 1))
  })

  it('keeps whole files and whole hunks, and names what was cut', () => {
    const diff = file('big.ts', 6) + file('other.ts', 1)
    const cut = truncateDiff(diff, 900)
    expect(cut.length).toBeLessThanOrEqual(1200)
    // Every hunk that is shown is complete, and the hunks that are missing are said to be.
    const starts = cut.match(/^@@ /gm) ?? []
    expect(starts.length).toBeGreaterThan(0)
    expect(starts.length).toBeLessThan(7)
    expect(cut.match(/^\+new \d+x{100}$/gm)).toHaveLength(starts.length)
    expect(cut).toMatch(/Not shown: .*big\.ts \(\d+ more hunks\)/)
  })

  it('names a file that does not fit at all', () => {
    const cut = truncateDiff(file('a.ts', 1) + file('huge.ts', 1) + 'y'.repeat(5000), 700)
    expect(cut).toContain('a.ts')
    expect(cut).toContain('huge.ts (whole file)')
  })
})

describe('reviewerTarget', () => {
  it('is undefined when off, when nothing is chosen, and when the model is missing', () => {
    expect(reviewerTarget(DEFAULT_SETTINGS)).toBeUndefined()
    expect(reviewerTarget({ ai: { reviewer: { enabled: true } } })).toBeUndefined()
    expect(reviewerTarget({ ai: { reviewer: { enabled: true, providerId: 'openai', model: ' ' } } })).toBeUndefined()
    expect(reviewerTarget({ ai: { reviewer: { enabled: false, providerId: 'openai', model: 'gpt-5-mini' } } })).toBeUndefined()
  })

  it('names the provider and model when on', () => {
    expect(reviewerTarget({ ai: { reviewer: { enabled: true, providerId: 'openai', model: 'gpt-5-mini' } } })).toEqual({ providerId: 'openai', model: 'gpt-5-mini' })
  })
})

describe('reviewTurn', () => {
  it('sends one request without tools and returns the verdict with usage', async () => {
    const send = vi.fn(async (_request: AIRequest) => reply('{"verdict":"revise","feedback":"1. src/date.ts: handle W53."}', { inputTokens: 900, outputTokens: 30 }))
    const result = await reviewTurn(input, send, { model: 'small' })
    expect(result).toEqual({ verdict: 'revise', feedback: '1. src/date.ts: handle W53.', usage: { inputTokens: 900, outputTokens: 30 } })
    const request = send.mock.calls[0]![0]
    expect(request.model).toBe('small')
    expect(request.tools).toBeUndefined()
    expect(JSON.stringify(request.messages)).toContain('ISO week dates')
  })

  it('approves when the request fails, and does not ask when nothing changed', async () => {
    const failing = vi.fn(async () => { throw new Error('429') })
    expect(await reviewTurn(input, failing)).toEqual({ verdict: 'approve', feedback: '' })
    const idle = vi.fn()
    expect(await reviewTurn({ ...input, diff: '  \n' }, idle)).toEqual({ verdict: 'approve', feedback: '' })
    expect(idle).not.toHaveBeenCalled()
  })

  it('approves at once when stopped while the reviewer is still thinking', async () => {
    const controller = new AbortController()
    const slow = vi.fn(() => new Promise<AIResponse>(() => undefined))
    const pending = reviewTurn(input, slow, { signal: controller.signal })
    controller.abort()
    expect(await pending).toEqual({ verdict: 'approve', feedback: '' })
  })
})
