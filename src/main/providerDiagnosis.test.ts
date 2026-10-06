import { describe, expect, it } from 'vitest'
import type { ProviderConfig } from '@core/types'
import { connectionChecked, connectionFix, modelNoun } from './providerDiagnosis'

const cfg = (overrides: Partial<ProviderConfig>): ProviderConfig => ({
  id: 'p',
  kind: 'openai-compat',
  name: 'P',
  accessType: 'api',
  auth: { type: 'api_key' },
  enabled: true,
  ...overrides
})

describe('connectionFix', () => {
  it('sends a rejected key to the page that issues keys for that provider', () => {
    expect(connectionFix(cfg({ kind: 'openai', baseUrl: 'https://api.openai.com/v1' }), 'Authentication failed: check the API key.')).toBe(
      'Paste a valid key from platform.openai.com/api-keys in Edit, save, then test again.'
    )
    expect(connectionFix(cfg({ baseUrl: 'https://api.groq.com/openai/v1' }), 'Authentication failed: check the API key.')).toContain('console.groq.com/keys')
  })

  it('still helps for a host it does not know', () => {
    expect(connectionFix(cfg({ baseUrl: 'https://llm.internal.example/v1' }), 'Authentication failed: check the API key.')).toBe(
      'Paste a valid key in Edit, save, then test again.'
    )
  })

  it('points Azure at Keys and Endpoint and the resource name', () => {
    const fix = connectionFix(cfg({ apiMode: 'azure', azureResource: 'res' }), 'Authentication failed: check the API key.')
    expect(fix).toContain('Keys and Endpoint')
    expect(fix).toContain('resource name')
  })

  it('asks for a key when none is set', () => {
    expect(connectionFix(cfg({ kind: 'gemini' }), 'No API key is set. Add one in the provider settings.')).toBe('Add an API key in Edit, save, then test again.')
  })

  it.each([
    ['ollama', 'Ollama not reachable at http://127.0.0.1:11434', /Start Ollama/],
    ['lmstudio', 'Not reachable at http://127.0.0.1:1234/v1: fetch failed', /Developer tab/],
    ['llamacpp', 'Not reachable at http://127.0.0.1:8080/v1: fetch failed', /llama-server/]
  ] as const)('tells a person to start %s', (kind, message, expected) => {
    expect(connectionFix(cfg({ kind, accessType: 'local', auth: { type: 'none' } }), message)).toMatch(expected)
  })

  it('tells a person to start a custom local server, and a cloud one to check the connection', () => {
    expect(connectionFix(cfg({ accessType: 'local' }), 'Not reachable at http://192.168.1.4:8000/v1: fetch failed')).toMatch(/Start the server/)
    expect(connectionFix(cfg({}), 'Not reachable at https://api.example.com/v1: fetch failed')).toMatch(/internet connection/)
  })

  it('does not treat Azure as a local server whatever it declares', () => {
    expect(connectionFix(cfg({ apiMode: 'azure', accessType: 'local' }), 'Not reachable at https://res.openai.azure.com: fetch failed')).toMatch(/internet connection/)
  })

  it.each([
    ['The request timed out after 8000ms', /did not answer in time/],
    ['Validation failed: 429 rate limit exceeded', /limiting this key/],
    ['Validation failed: Forbidden', /not allowed/],
    ['Validation failed: 404 Not Found', /most compatible hosts end it with \/v1/],
    ['No baseUrl configured for custom provider.', /address and field mapping/]
  ])('has a next step for %j', (message, expected) => {
    expect(connectionFix(cfg({}), message)).toMatch(expected)
  })

  it('falls back to checking the address and key', () => {
    expect(connectionFix(cfg({}), 'Validation failed: something odd')).toBe('Check the address and key in Edit, then test again.')
    expect(connectionFix(cfg({}), undefined)).toBe('Check the address and key in Edit, then test again.')
  })
})

describe('connectionChecked', () => {
  it.each([
    ['openai', 'Listed the models this key can use.'],
    ['gemini', 'Listed the models this key can use.'],
    ['anthropic', 'Sent a one-token message with this key.'],
    ['openai-compat', 'Asked the endpoint for its model list.'],
    ['lmstudio', 'Asked the endpoint for its model list.'],
    ['ollama', 'Asked the server for its version.'],
    ['custom', 'Reached the endpoint. The request and response mapping were not tested.'],
    ['mock', 'The offline demo needs no connection.']
  ] as const)('says what was done for %s', (kind, expected) => {
    expect(connectionChecked(cfg({ kind }))).toBe(expected)
  })

  it('says what was done for Azure', () => {
    expect(connectionChecked(cfg({ apiMode: 'azure' }))).toBe('Asked the resource for its models with this key.')
  })
})

describe('modelNoun', () => {
  it('calls an Azure resource\'s list deployments, and every other list models', () => {
    expect(modelNoun(cfg({ apiMode: 'azure' }))).toBe('deployments')
    expect(modelNoun(cfg({}))).toBe('models')
  })
})
