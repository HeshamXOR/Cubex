import { describe, it, expect } from 'vitest'
import { createWebFetchTool } from './webFetchTool'

const tool = createWebFetchTool()

describe('web_fetch guard', () => {
  it('is allow-permission (read-only)', () => {
    expect(tool.defaultPermission).toBe('allow')
  })

  it('rejects non-http schemes', async () => {
    const r = await tool.execute({ url: 'ftp://example.com/x' }, { requestPermission: async () => ({ decision: 'allow' }) })
    expect(r.isError).toBe(true)
    expect(String(r.content)).toMatch(/http\(s\)/i)
  })

  it('blocks localhost and private ranges (SSRF)', async () => {
    const ctx = { requestPermission: async () => ({ decision: 'allow' as const }) }
    for (const u of ['http://localhost/x', 'http://127.0.0.1/x', 'http://10.0.0.5/x', 'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data']) {
      const r = await tool.execute({ url: u }, ctx)
      expect(r.isError, u).toBe(true)
      expect(String(r.content)).toMatch(/local\/private network/i)
    }
  })

  it('errors on a missing url', async () => {
    const r = await tool.execute({}, { requestPermission: async () => ({ decision: 'allow' }) })
    expect(r.isError).toBe(true)
  })
})
