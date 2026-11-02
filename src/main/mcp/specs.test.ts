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

  it('names the secrets that cannot be read instead of starting the server without them', () => {
    const [spec] = enabledMcpSpecs([server({ secretEnv: { SENTRY_ACCESS_TOKEN: mcpSecretRef('srv', 'SENTRY_ACCESS_TOKEN') } })], () => undefined)
    expect(spec?.missingSecrets).toEqual(['SENTRY_ACCESS_TOKEN'])
    expect(spec?.env).toBeUndefined()
    expect(spec?.secretValues).toBeUndefined()
  })
})
