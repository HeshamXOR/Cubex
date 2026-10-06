import type { AccessType, ProviderConfig, ProviderKind } from '@core/types'

/**
 * The providers Cubex can set up in two clicks. Each one is a plain
 * `ProviderConfig` waiting for its key: a preset picks the kind, address, default
 * model and the way the key is sent, and says in a line what the person needs and
 * where to get it. Nothing here is a new adapter: the OpenAI-compatible hosts all
 * use `openai-compat`, and Azure OpenAI is `openai-compat` in its `azure` mode.
 */

export type PresetGroup = 'cloud' | 'local' | 'other'

export interface ProviderPreset {
  id: string
  label: string
  group: PresetGroup
  kind: ProviderKind
  accessType: AccessType
  /** Where the API lives. Absent when the person supplies it (Azure builds it from a resource name). */
  baseUrl?: string
  apiMode?: string
  apiVersion?: string
  defaultModel?: string
  /** How the key is sent; absent for a server that needs none. */
  key?: { scheme: 'bearer' | 'x-api-key' | 'raw'; header?: string }
  /** Without a key the provider cannot answer; a custom endpoint may not need one. */
  keyRequired: boolean
  /** One line: what the person needs and where to get it. */
  needs: string
  /** Where the key is created, short enough to put in a sentence. */
  keyPage?: string
  /** Azure OpenAI: a resource name and deployment names instead of an address and models. */
  azure?: true
  /** The generic JSON mapping form. */
  jsonMapping?: true
}

const CLOUD_KEY = { scheme: 'bearer' } as const

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    group: 'cloud',
    kind: 'openai',
    accessType: 'api',
    baseUrl: 'https://api.openai.com/v1',
    apiMode: 'responses',
    defaultModel: 'gpt-6-astra',
    key: CLOUD_KEY,
    keyRequired: true,
    needs: 'An API key from platform.openai.com. A ChatGPT plan does not include one.',
    keyPage: 'platform.openai.com/api-keys'
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    group: 'cloud',
    kind: 'anthropic',
    accessType: 'api',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-5',
    key: { scheme: 'x-api-key' },
    keyRequired: true,
    needs: 'An API key from platform.claude.com. A Claude plan does not include one.',
    keyPage: 'platform.claude.com/settings/keys'
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    group: 'cloud',
    kind: 'gemini',
    accessType: 'api',
    baseUrl: 'https://generativelanguage.googleapis.com',
    defaultModel: 'gemini-3.8-flash',
    key: CLOUD_KEY,
    keyRequired: true,
    needs: 'An API key from aistudio.google.com/apikey.',
    keyPage: 'aistudio.google.com/apikey'
  },
  {
    id: 'azure',
    label: 'Azure OpenAI',
    group: 'cloud',
    kind: 'openai-compat',
    accessType: 'api',
    apiMode: 'azure',
    apiVersion: 'v1',
    key: { scheme: 'raw', header: 'api-key' },
    keyRequired: true,
    needs: 'Your resource name, a deployment name and a key from the Azure portal, under Keys and Endpoint.',
    keyPage: 'the Azure portal, under Keys and Endpoint',
    azure: true
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    group: 'cloud',
    kind: 'openai-compat',
    accessType: 'api',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-oss-120b',
    key: CLOUD_KEY,
    keyRequired: true,
    needs: 'An API key from openrouter.ai/keys.',
    keyPage: 'openrouter.ai/keys'
  },
  {
    id: 'groq',
    label: 'Groq',
    group: 'cloud',
    kind: 'openai-compat',
    accessType: 'api',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    key: CLOUD_KEY,
    keyRequired: true,
    needs: 'An API key from console.groq.com/keys.',
    keyPage: 'console.groq.com/keys'
  },
  {
    id: 'together',
    label: 'Together',
    group: 'cloud',
    kind: 'openai-compat',
    accessType: 'api',
    baseUrl: 'https://api.together.ai/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    key: CLOUD_KEY,
    keyRequired: true,
    needs: 'An API key from api.together.ai, under Settings and API keys.',
    keyPage: 'api.together.ai, under Settings and API keys'
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    group: 'cloud',
    kind: 'openai-compat',
    accessType: 'api',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-pro',
    key: CLOUD_KEY,
    keyRequired: true,
    needs: 'An API key from platform.deepseek.com/api_keys.',
    keyPage: 'platform.deepseek.com/api_keys'
  },
  {
    id: 'mistral',
    label: 'Mistral',
    group: 'cloud',
    kind: 'openai-compat',
    accessType: 'api',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
    key: CLOUD_KEY,
    keyRequired: true,
    needs: 'An API key from console.mistral.ai/api-keys.',
    keyPage: 'console.mistral.ai/api-keys'
  },
  {
    id: 'xai',
    label: 'xAI',
    group: 'cloud',
    kind: 'openai-compat',
    accessType: 'api',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4.7',
    key: CLOUD_KEY,
    keyRequired: true,
    needs: 'An API key from console.x.ai.',
    keyPage: 'console.x.ai'
  },
  {
    id: 'nvidia',
    label: 'NVIDIA',
    group: 'cloud',
    kind: 'openai-compat',
    accessType: 'api',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    defaultModel: 'meta/llama-3.3-70b-instruct',
    key: CLOUD_KEY,
    keyRequired: true,
    needs: 'An API key from build.nvidia.com. It starts with nvapi-.',
    keyPage: 'build.nvidia.com'
  },
  {
    id: 'ollama',
    label: 'Ollama',
    group: 'local',
    kind: 'ollama',
    accessType: 'local',
    baseUrl: 'http://127.0.0.1:11434',
    keyRequired: false,
    needs: 'No key. Install Ollama from ollama.com and keep it running.'
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    group: 'local',
    kind: 'lmstudio',
    accessType: 'local',
    baseUrl: 'http://127.0.0.1:1234/v1',
    keyRequired: false,
    needs: "No key. Start the local server from LM Studio's Developer tab."
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp',
    group: 'local',
    kind: 'llamacpp',
    accessType: 'local',
    baseUrl: 'http://127.0.0.1:8080/v1',
    keyRequired: false,
    needs: 'No key. Start llama-server, then enter its address.'
  },
  {
    id: 'custom',
    label: 'Custom endpoint',
    group: 'other',
    kind: 'openai-compat',
    accessType: 'api',
    baseUrl: '',
    key: CLOUD_KEY,
    keyRequired: false,
    needs: 'Any OpenAI-compatible address, in the cloud or on your network. A key is optional.'
  },
  {
    id: 'custom-json',
    label: 'Custom JSON API',
    group: 'other',
    kind: 'custom',
    accessType: 'api',
    baseUrl: '',
    key: CLOUD_KEY,
    keyRequired: false,
    needs: 'An HTTP API with its own request and response format. You map the fields.',
    jsonMapping: true
  },
  {
    id: 'demo',
    label: 'Offline demo',
    group: 'other',
    kind: 'mock',
    accessType: 'local',
    keyRequired: false,
    needs: 'No key. Simulated replies for trying Cubex without a model.'
  }
]

export const PRESET_GROUPS: ReadonlyArray<{ id: PresetGroup; label: string }> = [
  { id: 'cloud', label: 'Cloud' },
  { id: 'local', label: 'On this PC' },
  { id: 'other', label: 'Other' }
]

export function presetById(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id)
}

/** The form's starting point for a preset: everything filled in except the key, which the person pastes. */
export function configFromPreset(preset: ProviderPreset, id: string): ProviderConfig {
  return {
    id,
    kind: preset.kind,
    name: preset.label,
    accessType: preset.accessType,
    ...(preset.baseUrl !== undefined ? { baseUrl: preset.baseUrl } : {}),
    ...(preset.apiMode ? { apiMode: preset.apiMode } : {}),
    ...(preset.apiVersion ? { apiVersion: preset.apiVersion } : {}),
    ...(preset.defaultModel ? { defaultModel: preset.defaultModel } : {}),
    ...(preset.azure ? { azureResource: '', azureDeployments: [] } : {}),
    ...(preset.jsonMapping
      ? { mapping: { shape: 'rest' as const, method: 'POST' as const, promptField: 'prompt', modelField: 'model', responseTextPath: 'text' } }
      : {}),
    auth: preset.key
      ? { type: 'api_key', scheme: preset.key.scheme, ...(preset.key.header ? { headerName: preset.key.header } : {}) }
      : { type: 'none' },
    enabled: true
  }
}

/** The host of an address, with its port when it has one; undefined when the text is not an address. */
export function hostOf(address: string | undefined): string | undefined {
  if (!address?.trim()) return undefined
  try {
    return new URL(address.trim()).host.toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * The preset a saved provider came from, found by what it connects to rather than by
 * its name, which the person may have changed. A provider with no address is
 * matched by kind alone for the three whose adapters know their own.
 */
export function presetFor(cfg: Pick<ProviderConfig, 'kind' | 'apiMode' | 'baseUrl'>): ProviderPreset | undefined {
  if (cfg.kind === 'openai-compat' && cfg.apiMode === 'azure') return presetById('azure')
  const host = hostOf(cfg.baseUrl)
  const sameKind = PROVIDER_PRESETS.filter((preset) => preset.kind === cfg.kind && !preset.azure && preset.baseUrl)
  if (host) return sameKind.find((preset) => hostOf(preset.baseUrl) === host)
  return cfg.kind === 'openai' || cfg.kind === 'anthropic' || cfg.kind === 'gemini' ? sameKind[0] : undefined
}

/** Where a provider lives, short enough for a row: its host, or the Azure resource's. */
export function endpointLabel(cfg: Pick<ProviderConfig, 'kind' | 'apiMode' | 'baseUrl' | 'azureResource'>): string | undefined {
  if (cfg.kind === 'openai-compat' && cfg.apiMode === 'azure' && !cfg.baseUrl?.trim()) {
    const resource = cfg.azureResource?.trim()
    return resource ? `${resource}.openai.azure.com` : undefined
  }
  return hostOf(cfg.baseUrl) ?? hostOf(presetFor(cfg)?.baseUrl)
}
