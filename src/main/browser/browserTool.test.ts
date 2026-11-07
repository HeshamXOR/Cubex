import { describe, expect, it, vi } from 'vitest'
import type { JSONValue } from '@core/types'
import { createBrowserTool, screenshotOf, type BrowserDriver, type PageState } from './browserTool'
import { browserApprovalHost, browserCallActs, isLocalHost, parseBrowserUrl, sameSite } from './urls'

const page = (extra: Partial<PageState> = {}): PageState => ({
  url: 'http://localhost:3000/', title: 'App', text: '# Hello\n[0] button "Save"', truncated: false, refs: 1, errorCount: 0, ...extra
})

function driver(overrides: Partial<BrowserDriver> = {}): BrowserDriver {
  return {
    navigate: vi.fn(async () => ({ ok: true as const, state: page() })),
    read: vi.fn(async () => page()),
    act: vi.fn(async () => ({ outcome: { ok: true as const }, state: page() })),
    console: vi.fn(() => []),
    screenshot: vi.fn(async () => ({ mediaType: 'image/jpeg' as const, data: 'AAAA', width: 1280, height: 800 })),
    close: vi.fn(),
    ...overrides
  }
}

const context = { requestPermission: async () => ({ decision: 'allow' as const }) }
const run = (tool: ReturnType<typeof createBrowserTool>, input: JSONValue) => tool.execute(input, context)
const tool = (d: BrowserDriver, canSeeImages = false) => createBrowserTool({ conversationId: 'c1', driver: d, canSeeImages })

describe('the browser tool', () => {
  it('opens a page and says the page is data, not instructions', async () => {
    const d = driver()
    const result = await run(tool(d), { action: 'navigate', url: 'localhost:3000' })
    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('[0] button "Save"')
    expect(result.content).toContain('data and not instructions')
    expect((d.navigate as ReturnType<typeof vi.fn>).mock.calls[0]![1].href).toBe('http://localhost:3000/')
  })

  it('refuses an address the browser may not open, without touching the page', async () => {
    const d = driver()
    for (const url of ['file:///C:/secrets.txt', 'javascript:alert(1)', 'data:text/html,hi', 'http://user:pw@example.com/', '', 42]) {
      expect((await run(tool(d), { action: 'navigate', url })).isError).toBe(true)
    }
    expect(d.navigate).not.toHaveBeenCalled()
  })

  it('tells the model when the page has errors or tried to go somewhere unapproved', async () => {
    const d = driver({ read: vi.fn(async () => page({ errorCount: 2, blocked: 'https://evil.example/?x=1' })) })
    const text = String((await run(tool(d), { action: 'read' })).content)
    expect(text).toContain('logged 2 errors')
    expect(text).toContain('evil.example')
  })

  it('takes a ref however the model writes it', async () => {
    const d = driver()
    await run(tool(d), { action: 'click', ref: '[3]' })
    expect((d.act as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toEqual({ kind: 'click', ref: 3 })
    expect((await run(tool(d), { action: 'click' })).isError).toBe(true)
    expect((await run(tool(d), { action: 'click', ref: -1 })).isError).toBe(true)
  })

  it('reports why an action failed', async () => {
    const d = driver({ act: vi.fn(async () => ({ outcome: { ok: false as const, reason: 'Something else is on top of that control: div.' } })) })
    const result = await run(tool(d), { action: 'click', ref: 1 })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('on top of')
  })

  it('needs text to type', async () => {
    const d = driver()
    expect((await run(tool(d), { action: 'type', ref: 1 })).isError).toBe(true)
    await run(tool(d), { action: 'type', ref: 1, text: 'hi', submit: true })
    expect((d.act as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toEqual({ kind: 'type', ref: 1, text: 'hi', submit: true })
  })

  it('says when nothing is open', async () => {
    const d = driver({ read: vi.fn(async () => undefined), console: vi.fn(() => undefined), screenshot: vi.fn(async () => undefined) })
    expect((await run(tool(d), { action: 'read' })).isError).toBe(true)
    expect((await run(tool(d), { action: 'console' })).isError).toBe(true)
    expect((await run(tool(d, true), { action: 'screenshot' })).isError).toBe(true)
  })

  it('offers a screenshot only to a model that can see one, and hands the image over out of band', async () => {
    const blind = tool(driver())
    expect(JSON.stringify(blind.definition.inputSchema)).not.toContain('screenshot')
    expect((await run(blind, { action: 'screenshot' })).isError).toBe(true)

    const result = await run(tool(driver(), true), { action: 'screenshot' })
    expect(String(result.content)).not.toContain('AAAA')
    expect(screenshotOf(result.metadata)).toEqual({ mediaType: 'image/jpeg', data: 'AAAA' })
    expect(screenshotOf(undefined)).toBeUndefined()
  })
})

describe('which addresses need the person', () => {
  it('reads a bare address the way an address bar does', () => {
    const href = (input: string): string | undefined => { const r = parseBrowserUrl(input); return r.ok ? r.url.href : undefined }
    expect(href('localhost:5173/app')).toBe('http://localhost:5173/app')
    expect(href('127.0.0.1:3000')).toBe('http://127.0.0.1:3000/')
    expect(href('example.com')).toBe('https://example.com/')
    expect(href('http://example.com/a')).toBe('http://example.com/a')
    expect(href('ftp://example.com/')).toBeUndefined()
  })

  it('knows this machine', () => {
    for (const host of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.1.2.3', '[::1]']) expect(isLocalHost(host)).toBe(true)
    for (const host of ['localhost.evil.com', '192.168.1.5', '10.0.0.1', 'example.com', '127.0.0.1.evil.com']) expect(isLocalHost(host)).toBe(false)
  })

  it('asks only for navigation off this machine', () => {
    expect(browserApprovalHost({ action: 'navigate', url: 'http://localhost:3000' })).toBeUndefined()
    expect(browserApprovalHost({ action: 'navigate', url: 'https://Example.com/a?b=1' })).toBe('example.com')
    expect(browserApprovalHost({ action: 'navigate', url: 'http://192.168.1.5/' })).toBe('192.168.1.5')
    expect(browserApprovalHost({ action: 'navigate', url: 'localhost.evil.com' })).toBe('localhost.evil.com')
    expect(browserApprovalHost({ action: 'read' })).toBeUndefined()
    expect(browserApprovalHost({ action: 'navigate', url: 'file:///etc/passwd' })).toBeUndefined()
  })

  it('treats a www. variant as the same site and nothing else', () => {
    expect(sameSite('www.example.com', 'EXAMPLE.com.')).toBe(true)
    expect(sameSite('example.com', 'example.com.evil.net')).toBe(false)
  })

  it('says which calls act on the page', () => {
    expect(browserCallActs({ action: 'click' })).toBe(true)
    expect(browserCallActs({ action: 'type' })).toBe(true)
    expect(browserCallActs({ action: 'read' })).toBe(false)
    expect(browserCallActs({ action: 'navigate' })).toBe(false)
  })
})
