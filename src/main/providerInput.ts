import { ALL_CAPABILITIES, type AccessType, type AuthMethod, type Capability, type CustomProviderMapping, type ProviderConfig, type ProviderKind } from '@core/types'
import { MAX_LONG_CONTEXT_MODELS, normalizeLongContextModels } from '@shared/longContext'

/**
 * What the window may hand to the provider handlers. The window is our own code, but a saved
 * provider decides where requests go and which stored key goes with them, so main checks the shape
 * instead of trusting it: a wrong value fails with a sentence, never with a half-saved provider.
 */

/** Records rather than lists, so a new kind or access type fails to compile here until it is allowed. */
const KIND_SET = { openai: true, anthropic: true, 'openai-compat': true, gemini: true, custom: true, ollama: true, llamacpp: true, lmstudio: true, mock: true, 'mock-local': true } satisfies Record<ProviderKind, true>
const ACCESS_SET = { api: true, oauth: true, subscription: true, local: true } satisfies Record<AccessType, true>
const KINDS = Object.keys(KIND_SET) as ProviderKind[]
const ACCESS = Object.keys(ACCESS_SET) as AccessType[]
const SCHEMES = ['bearer', 'raw', 'x-api-key'] as const
const SHAPES = ['openai', 'anthropic', 'rest'] as const

const ID = /^[A-Za-z0-9_.:-]{1,120}$/
const CREDENTIAL_REF = /^cred_[A-Za-z0-9_.-]{1,140}$/
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,100}$/
const AZURE_RESOURCE = /^[A-Za-z0-9-]{0,100}$/

const fail = (problem: string): never => {
  throw new Error(`The provider settings are not valid. ${problem}`)
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function text(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return fail(`${field} must be text.`)
  if (value.length > max) return fail(`${field} is longer than ${max} characters.`)
  return value
}

function requiredText(value: unknown, field: string, max: number): string {
  const result = text(value, field, max)
  return result === undefined || !result.trim() ? fail(`${field} is required.`) : result
}

function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fail(`${field} is not one Cubex knows.`)
}

function stringList(value: unknown, field: string, maxItems: number, maxLength: number): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > maxItems) return fail(`${field} must be a list of at most ${maxItems} items.`)
  return value.map((item) => text(item, field, maxLength) ?? fail(`${field} must be a list of text.`))
}

function flag(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined
  return typeof value === 'boolean' ? value : fail(`${field} must be true or false.`)
}

/** Empty means "not set". Anything else must be a web address: a saved provider only ever talks http or https. */
function address(value: unknown): string | undefined {
  const raw = text(value, 'The address', 2048)
  if (raw === undefined || !raw.trim()) return raw === undefined ? undefined : ''
  let protocol = ''
  try {
    protocol = new URL(raw.trim()).protocol
  } catch {
    // Reported below with the same sentence as a wrong scheme.
  }
  return protocol === 'http:' || protocol === 'https:' ? raw : fail('The address must start with http:// or https://.')
}

function parseAuth(value: unknown): AuthMethod {
  if (!isRecord(value)) return fail('The way the key is sent is missing.')
  switch (value.type) {
    case 'none':
    case 'bearer':
    case 'custom_headers':
      return { type: value.type }
    case 'api_key': {
      const headerName = text(value.headerName, 'The key header', 100)
      if (headerName && !HEADER_NAME.test(headerName)) return fail('The key header is not a valid header name.')
      return {
        type: 'api_key',
        ...(headerName ? { headerName } : {}),
        ...(value.scheme !== undefined ? { scheme: oneOf(value.scheme, 'The key scheme', SCHEMES) } : {})
      }
    }
    case 'oauth': {
      const scopes = stringList(value.scopes, 'The scopes', 50, 200)
      return { type: 'oauth', provider: requiredText(value.provider, 'The sign-in provider', 100), ...(scopes ? { scopes } : {}) }
    }
    case 'env': {
      const varName = requiredText(value.varName, 'The variable name', 101)
      return ENV_NAME.test(varName) ? { type: 'env', varName } : fail('The variable name may only use letters, digits and underscores.')
    }
    default:
      return fail('The way the key is sent is not one Cubex knows.')
  }
}

function parseHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) return fail('Headers must be a list of names and values.')
  const entries = Object.entries(value)
  if (entries.length > 50) return fail('There are more than 50 headers.')
  const headers: Record<string, string> = {}
  for (const [name, headerValue] of entries) {
    if (!HEADER_NAME.test(name)) return fail(`"${name.slice(0, 40)}" is not a valid header name.`)
    if (typeof headerValue !== 'string' || headerValue.length > 4096 || /[\r\n]/.test(headerValue)) return fail(`The value of header ${name} must be one line of text.`)
    headers[name] = headerValue
  }
  return headers
}

function parseMapping(value: unknown): CustomProviderMapping | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) return fail('The request mapping must be an object.')
  const mapping: CustomProviderMapping = {}
  if (value.method !== undefined) mapping.method = oneOf(value.method, 'The method', ['POST', 'GET'] as const)
  for (const name of ['promptField', 'modelField', 'streamField', 'responseTextPath'] as const) {
    const parsed = text(value[name], `The ${name} of the request mapping`, 200)
    if (parsed !== undefined) mapping[name] = parsed
  }
  const sse = flag(value.sse, 'The streaming flag of the request mapping')
  if (sse !== undefined) mapping.sse = sse
  if (value.shape !== undefined) mapping.shape = oneOf(value.shape, 'The shape of the request mapping', SHAPES)
  return mapping
}

function parseCapabilities(value: unknown): Capability[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > ALL_CAPABILITIES.length * 2) return fail('Capabilities must be a list.')
  return [...new Set(value.map((item) => oneOf(item, 'A capability', ALL_CAPABILITIES)))]
}

/**
 * The provider the window asked to save, checked and reduced to the fields Cubex knows (a field an
 * older version stored and nothing reads any more is dropped, not an error). Throws a plain sentence when a value is wrong.
 */
export function parseProviderConfig(value: unknown): ProviderConfig {
  if (!isRecord(value)) return fail('The provider is missing.')

  const id = requiredText(value.id, 'The id', 120)
  if (!ID.test(id)) return fail('The id may only use letters, digits and - _ . :')
  const credentialRef = text(value.credentialRef, 'The stored key reference', 160)
  if (credentialRef && !CREDENTIAL_REF.test(credentialRef)) return fail('The stored key reference is not one Cubex created.')
  const azureResource = text(value.azureResource, 'The Azure resource', 100)
  if (azureResource !== undefined && !AZURE_RESOURCE.test(azureResource)) return fail('The Azure resource may only use letters, digits and hyphens.')

  const baseUrl = address(value.baseUrl)
  const apiMode = text(value.apiMode, 'The API mode', 40)
  const apiVersion = text(value.apiVersion, 'The API version', 40)
  const azureDeployments = stringList(value.azureDeployments, 'The deployments', 100, 200)
  const headers = parseHeaders(value.headers)
  const capabilities = parseCapabilities(value.capabilities)
  const longContextModels = normalizeLongContextModels(stringList(value.longContextModels, 'The 1M context models', MAX_LONG_CONTEXT_MODELS, 200))
  const defaultModel = text(value.defaultModel, 'The default model', 200)
  const mapping = parseMapping(value.mapping)
  const promptCaching = flag(value.promptCaching, 'Prompt caching')
  const enabled = flag(value.enabled, 'The on and off switch')
  if (enabled === undefined) return fail('The on and off switch is missing.')

  return {
    id,
    kind: oneOf(value.kind, 'The provider kind', KINDS),
    name: requiredText(value.name, 'The name', 120),
    accessType: oneOf(value.accessType, 'The access type', ACCESS),
    auth: parseAuth(value.auth),
    enabled,
    ...(promptCaching !== undefined ? { promptCaching } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(apiMode !== undefined ? { apiMode } : {}),
    ...(apiVersion !== undefined ? { apiVersion } : {}),
    ...(azureResource !== undefined ? { azureResource } : {}),
    ...(azureDeployments ? { azureDeployments } : {}),
    ...(credentialRef ? { credentialRef } : {}),
    ...(headers ? { headers } : {}),
    ...(capabilities ? { capabilities } : {}),
    ...(longContextModels ? { longContextModels } : {}),
    ...(defaultModel !== undefined ? { defaultModel } : {}),
    ...(mapping ? { mapping } : {})
  }
}

/** A provider id the window sent: bounded, with nothing a lookup or a file name could trip on. */
export function parseProviderId(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('Invalid provider id.')
  return value
}

/** The key the person pasted. Undefined when none was sent; whitespace around a pasted key is never part of it. */
export function parseSecret(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error('The key must be text.')
  const secret = value.trim()
  if (secret.length > 16_384) throw new Error('The key is longer than any provider issues. Check that you pasted the right text.')
  return secret || undefined
}
