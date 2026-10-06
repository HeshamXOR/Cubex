import { describe, expect, it, vi } from 'vitest'
import { mcpSecretRef } from '@shared/policy'
import type { McpServerConfig } from '@shared/settings'

// The real reader asks the operating system's credential store, which needs Electron.
vi.mock('../credentials', () => ({ getSecret: () => undefined }))

import { enabledMcpSpecs } from './specs'

const server = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({ id: 'srv', name: 'Sentry', command: 'npx', args: ['-y', '@sentry/mcp-server'], enabled: true, ...over })

describe('enabledMcpSpecs', () => {
  it('keeps the servers that are on and have a command, and nothing else about them', () => {
    const specs = enabledMcpSpecs([server(), server({ id: 'off', enabled: false }), server({ id: 'blank', command: '' })], () => undefined)
    expect(specs).toEqual([{ id: 'srv', name: 'Sentry', command: 'npx', args: ['-y', '@sentry/mcp-server'] }])
    expect(enabledMcpSpecs(undefined, () => undefined)).toEqual([])
  })

  it('starts a server written before variables existed exactly as it was', () => {
    const read = vi.fn()
    expect(enabledMcpSpecs([{ id: 'old', name: 'Old', command: 'node', enabled: true }], read)).toEqual([{ id: 'old', name: 'Old', command: 'node' }])
    expect(read).not.toHaveBeenCalled()
  })

  it('gives each server its plain variables and its secrets, and lists the secret values for scrubbing', () => {
    const ref = mcpSecretRef('srv', 'SENTRY_ACCESS_TOKEN')
    const [spec] = enabledMcpSpecs(
      [server({ env: { SENTRY_ORG: 'lumen' }, secretEnv: { SENTRY_ACCESS_TOKEN: ref } })],
      (wanted) => (wanted === ref ? 'sntrys_abcdef123456' : undefined)
    )
    expect(spec).toMatchObject({ env: { SENTRY_ORG: 'lumen', SENTRY_ACCESS_TOKEN: 'sntrys_abcdef123456' }, secretValues: ['sntrys_abcdef123456'] })
    expect(spec?.missingSecrets).toBeUndefined()
  })

  it('names the secrets that cannot be read instead of starting the server without them', () => {
    const [spec] = enabledMcpSpecs([server({ secretEnv: { SENTRY_ACCESS_TOKEN: mcpSecretRef('srv', 'SENTRY_ACCESS_TOKEN') } })], () => undefined)
    expect(spec?.missingSecrets).toEqual(['SENTRY_ACCESS_TOKEN'])
    expect(spec?.env).toBeUndefined()
    expect(spec?.secretValues).toBeUndefined()
  })
})
