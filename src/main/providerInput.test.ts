import { describe, expect, it } from 'vitest'
import { type ProviderConfig } from '@core/types'
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

  it('only allows web addresses', () => {
    for (const baseUrl of ['ftp://example.com', 'file:///C:/secrets', 'javascript:alert(1)', 'localhost:11434', 'not a url']) {
      rejects({ baseUrl }, /The address must start with http:\/\/ or https:\/\//)
    }
    expect(parseProviderConfig({ ...base(), baseUrl: 'http://127.0.0.1:11434' }).baseUrl).toBe('http://127.0.0.1:11434')
  })

  it('only accepts a stored key reference that Cubex creates', () => {
    for (const credentialRef of ['groq', '../cred_x', 'cred_', 'cred_a b', 'env:HOME']) rejects({ credentialRef }, /The stored key reference is not one Cubex created\./)
  })

  it('refuses a header that could split a request', () => {
    rejects({ headers: { 'bad name': 'x' } }, /is not a valid header name\./)
    rejects({ headers: { 'X-Team': 'a\r\nHost: evil' } }, /must be one line of text\./)
    rejects({ headers: { 'X-Team': 7 } }, /must be one line of text\./)
    rejects({ headers: Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`X-${index}`, 'v'])) }, /more than 50 headers\./)
  })
})

describe('parseProviderId', () => {

  it.each([[''], ['../x'], ['a b'], ['a'.repeat(121)], [undefined], [null], [5], [{}]])('refuses %j', (value) => {
    expect(() => parseProviderId(value)).toThrow('Invalid provider id.')
  })
})

describe('parseSecret', () => {

  it('refuses text that is not a key', () => {
    expect(() => parseSecret(42)).toThrow('The key must be text.')
    expect(() => parseSecret('k'.repeat(16_385))).toThrow('longer than any provider issues')
  })
})
