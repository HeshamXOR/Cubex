import { describe, expect, it } from 'vitest'
import { ALL_CAPABILITIES, type ProviderConfig } from '@core/types'
import { PROVIDER_PRESETS, configFromPreset } from '@shared/providerPresets'
import { parseProviderConfig, parseProviderId, parseSecret } from './providerInput'

/** Every field of the type, so adding one to `ProviderConfig` fails to compile here and then fails the round trip until the parser keeps it. */
const full: Required<ProviderConfig> = {
  promptCaching: false,
  id: '-a3F9k_x',
  kind: 'openai-compat',
  name: 'Contoso',
  accessType: 'api',
  baseUrl: 'https://contoso.example.com/v1',
  apiMode: 'azure',
  apiVersion: '2024-10-21',
  azureResource: 'contoso-prod',
  azureDeployments: ['gpt-prod', 'o3-mini-eu'],
  auth: { type: 'api_key', scheme: 'raw', headerName: 'api-key' },
  credentialRef: 'cred_-a3F9k_x_Zq81Lm',
  headers: { 'X-Team': 'platform' },
  capabilities: ['text', 'streaming', 'tools'],
  longContextModels: ['gpt-prod', 'gpt-prod-long'],
  defaultModel: 'gpt-prod',
  mapping: { method: 'POST', promptField: 'prompt', modelField: 'model', streamField: 'stream', responseTextPath: 'choices.0.text', sse: true, shape: 'rest' },
  enabled: true
}

const base = (): Record<string, unknown> => ({ ...full })
const rejects = (change: Record<string, unknown>, message: RegExp): void => {
  expect(() => parseProviderConfig({ ...base(), ...change })).toThrow(message)
}

describe('parseProviderConfig', () => {
  it('keeps every field of a fully filled provider', () => {
    expect(parseProviderConfig(full)).toEqual(full)
  })

  it('accepts what each preset offers the form to start from', () => {
    for (const preset of PROVIDER_PRESETS) {
      const config = configFromPreset(preset, 'abc12345')
      expect(parseProviderConfig(config), preset.id).toEqual(config)
    }
  })

  it('accepts the other auth methods', () => {
    for (const auth of [{ type: 'none' }, { type: 'bearer' }, { type: 'custom_headers' }, { type: 'env', varName: 'CUBEX_KEY' }, { type: 'oauth', provider: 'google', scopes: ['a', 'b'] }]) {
      expect(parseProviderConfig({ ...base(), auth }).auth).toEqual(auth)
    }
  })

  it('treats an unset or empty address as not set, and ignores fields left undefined', () => {
    expect(parseProviderConfig({ ...base(), baseUrl: '' }).baseUrl).toBe('')
    expect(parseProviderConfig({ ...base(), baseUrl: undefined, defaultModel: undefined }).baseUrl).toBeUndefined()
  })

  it('drops a field an older version stored and nothing reads any more', () => {
    const parsed = parseProviderConfig({ ...base(), organization: 'org-1', region: 'eu' }) as unknown as Record<string, unknown>
    expect('organization' in parsed).toBe(false)
    expect('region' in parsed).toBe(false)
  })

  it('does not hand back the object it was given', () => {
    const input = base()
    expect(parseProviderConfig(input)).not.toBe(input)
  })

  it.each([[null], [undefined], ['openai'], [7], [[]]])('refuses %j as a provider', (value) => {
    expect(() => parseProviderConfig(value)).toThrow('The provider is missing.')
  })

  it('refuses an id that could be mistaken for a path or lookup', () => {
    for (const id of ['', '../secrets', 'a b', 'a/b', 'a'.repeat(121), 'ok\n']) rejects({ id }, /The provider settings are not valid\./)
    rejects({ id: 5 }, /The id must be text\./)
  })

  it('refuses a kind or access type it does not know', () => {
    rejects({ kind: 'skynet' }, /The provider kind is not one Cubex knows\./)
    rejects({ accessType: 'telepathy' }, /The access type is not one Cubex knows\./)
  })

  it('needs a name and the on and off switch', () => {
    rejects({ name: '   ' }, /The name is required\./)
    rejects({ enabled: undefined }, /The on and off switch is missing\./)
    rejects({ enabled: 'yes' }, /The on and off switch must be true or false\./)
  })

  it('only allows web addresses', () => {
    for (const baseUrl of ['ftp://example.com', 'file:///C:/secrets', 'javascript:alert(1)', 'localhost:11434', 'not a url']) {
      rejects({ baseUrl }, /The address must start with http:\/\/ or https:\/\//)
    }
    expect(parseProviderConfig({ ...base(), baseUrl: 'http://127.0.0.1:11434' }).baseUrl).toBe('http://127.0.0.1:11434')
  })

  it('only accepts a stored key reference that Cubex creates', () => {
    for (const credentialRef of ['groq', '../cred_x', 'cred_', 'cred_a b', 'env:HOME']) rejects({ credentialRef }, /The stored key reference is not one Cubex created\./)
  })

  it('checks the auth method', () => {
    rejects({ auth: undefined }, /The way the key is sent is missing\./)
    rejects({ auth: { type: 'magic' } }, /The way the key is sent is not one Cubex knows\./)
    rejects({ auth: { type: 'api_key', scheme: 'plain' } }, /The key scheme is not one Cubex knows\./)
    rejects({ auth: { type: 'api_key', headerName: 'bad header' } }, /The key header is not a valid header name\./)
    rejects({ auth: { type: 'env', varName: 'MY-KEY' } }, /The variable name may only use letters, digits and underscores\./)
    rejects({ auth: { type: 'oauth' } }, /The sign-in provider is required\./)
  })

  it('refuses a header that could split a request', () => {
    rejects({ headers: { 'bad name': 'x' } }, /is not a valid header name\./)
    rejects({ headers: { 'X-Team': 'a\r\nHost: evil' } }, /must be one line of text\./)
    rejects({ headers: { 'X-Team': 7 } }, /must be one line of text\./)
    rejects({ headers: Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`X-${index}`, 'v'])) }, /more than 50 headers\./)
  })

  it('checks the 1M context models', () => {
    rejects({ longContextModels: ['a', 7] }, /The 1M context models must be text\./)
    rejects({ longContextModels: Array.from({ length: 51 }, (_, i) => `m${i}`) }, /The 1M context models must be a list of at most 50 items\./)
    expect(parseProviderConfig({ ...base(), longContextModels: ['  claude-sonnet-4-5  ', 'claude-sonnet-4-5', '', 'claude-opus-4-8'] }).longContextModels)
      .toEqual(['claude-sonnet-4-5', 'claude-opus-4-8'])
    expect(parseProviderConfig({ ...base(), longContextModels: [] }).longContextModels).toBeUndefined()
  })

  it('checks capabilities and the request mapping', () => {
    rejects({ capabilities: ['text', 'mind_reading'] }, /A capability is not one Cubex knows\./)
    rejects({ mapping: { method: 'DELETE' } }, /The method is not one Cubex knows\./)
    rejects({ mapping: { shape: 'xml' } }, /The shape of the request mapping is not one Cubex knows\./)
    rejects({ mapping: { sse: 'yes' } }, /The streaming flag of the request mapping must be true or false\./)
    expect(parseProviderConfig({ ...base(), capabilities: ['text', 'text', ...ALL_CAPABILITIES.slice(0, 2)] }).capabilities).toEqual(['text', 'streaming'])
  })

  it('bounds the Azure fields', () => {
    rejects({ azureResource: 'has space' }, /The Azure resource may only use letters, digits and hyphens\./)
    rejects({ azureDeployments: Array.from({ length: 101 }, () => 'd') }, /at most 100 items\./)
  })
})

describe('parseProviderId', () => {
  it('accepts the ids Cubex generates, including ones that start with a dash or underscore', () => {
    for (const id of ['openai', 'k3Jd8_Qa', '-a3F9k_x', '_x', 'mock-local']) expect(parseProviderId(id)).toBe(id)
  })

  it.each([[''], ['../x'], ['a b'], ['a'.repeat(121)], [undefined], [null], [5], [{}]])('refuses %j', (value) => {
    expect(() => parseProviderId(value)).toThrow('Invalid provider id.')
  })
})

describe('parseSecret', () => {
  it('returns nothing when no key was sent', () => {
    for (const value of [undefined, null, '', '   \n']) expect(parseSecret(value)).toBeUndefined()
  })

  it('trims the whitespace a paste brings along', () => {
    expect(parseSecret('  sk-abc123\n')).toBe('sk-abc123')
  })

  it('refuses text that is not a key', () => {
    expect(() => parseSecret(42)).toThrow('The key must be text.')
    expect(() => parseSecret('k'.repeat(16_385))).toThrow('longer than any provider issues')
  })
})
