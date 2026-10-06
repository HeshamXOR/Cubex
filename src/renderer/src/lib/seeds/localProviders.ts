import type { CubexAPI, ModelRefreshResult, Preset } from '../../../../shared/ipc'
import type { ProviderConfig, ValidationResult } from '@core/types'
import type { PreviewSeed } from './index'

/**
 * Sample data for the Providers and Presets views in the browser preview. Providers and presets live in
 * memory here, so adding, editing, switching and removing one in the preview behaves like the real thing.
 * Flags (all with `?seed=1`):
 *   providers=empty      no providers yet
 *   providers=many       more providers, including a long name and a long address, and a disabled one
 *   providers=nokey      the cloud providers have no key saved
 *   providers=testfail   every connection test fails, each with its own cause and fix
 *   providers=testslow   connection tests take several seconds
 *   providers=savefail   saving a provider fails
 *   presets=many         a few saved presets: one with a long name and prompt, one whose provider was removed
 *   presets=fail         the same presets, but saving or deleting one fails
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** A stable pseudo-latency per provider, so the preview shows varied numbers that do not change between runs. */
function latencyOf(id: string): number {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 997
  return 90 + (hash % 340)
}

const BASE_URLS: Record<string, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
  ollama: 'http://127.0.0.1:11434'
}

const CHECKED: Record<string, string> = {
  anthropic: 'Sent a one-token message with this key.',
  openai: 'Listed the models this key can use.',
  gemini: 'Listed the models this key can use.',
  'openai-compat': 'Asked the endpoint for its model list.',
  lmstudio: 'Asked the endpoint for its model list.',
  llamacpp: 'Asked the endpoint for its model list.',
  ollama: 'Asked the server for its version.',
  custom: 'Reached the endpoint. The request and response mapping were not tested.'
}

async function initialProviders(flags: URLSearchParams): Promise<ProviderConfig[]> {
  const mode = flags.get('providers')
  if (mode === 'empty') return []
  const { seedProviders } = await import('../previewSeed')
  const withKey = mode !== 'nokey'
  const base: ProviderConfig[] = seedProviders.map((p) => ({
    ...p,
    ...(BASE_URLS[p.id] ? { baseUrl: BASE_URLS[p.id] } : {}),
    ...(p.auth.type !== 'none' && withKey ? { credentialRef: `cred_${p.id}` } : {})
  }))
  if (mode !== 'many') return base
  return [
    ...base,
    { id: 'groq', kind: 'openai-compat', name: 'Groq', accessType: 'api', baseUrl: 'https://api.groq.com/openai/v1', auth: { type: 'api_key', scheme: 'bearer' }, credentialRef: 'cred_groq', defaultModel: 'llama-3.3-70b-versatile', enabled: true },
    { id: 'azure', kind: 'openai-compat', apiMode: 'azure', name: 'Azure OpenAI', accessType: 'api', azureResource: 'contoso-prod', azureDeployments: ['gpt-prod', 'o3-mini-eu'], apiVersion: 'v1', auth: { type: 'api_key', scheme: 'raw', headerName: 'api-key' }, credentialRef: 'cred_azure', defaultModel: 'gpt-prod', enabled: true },
    { id: 'lmstudio', kind: 'lmstudio', name: 'LM Studio', accessType: 'local', baseUrl: 'http://127.0.0.1:1234/v1', auth: { type: 'none' }, enabled: false },
    {
      id: 'gateway',
      kind: 'openai-compat',
      name: 'Internal model gateway for the platform engineering team, production environment (EU West)',
      accessType: 'api',
      baseUrl: 'https://llm-gateway.platform.internal.example-corp.com/openai/deployments/v1',
      auth: { type: 'api_key', scheme: 'bearer' },
      defaultModel: 'mistralai/Mixtral-8x22B-Instruct-v0.1-long-context-fine-tuned-for-support',
      enabled: true
    }
  ]
}

function failureFor(cfg: ProviderConfig): ValidationResult {
  const latencyMs = latencyOf(cfg.id)
  if (cfg.kind === 'ollama') {
    return { ok: false, message: 'Ollama not reachable at http://127.0.0.1:11434', details: { latencyMs, fix: 'Start Ollama, then test again. If it runs on another machine, put its address in Edit.' } }
  }
  if (cfg.kind === 'openai-compat') {
    return { ok: false, message: 'Validation failed: Not Found', details: { latencyMs, fix: 'The endpoint answered but has no such route. Check the address in Edit; most compatible hosts end it with /v1.' } }
  }
  if (cfg.kind === 'anthropic') {
    return { ok: false, message: 'Authentication failed: check the API key.', details: { latencyMs, fix: 'Paste a valid key from platform.claude.com/settings/keys in Edit, save, then test again.' } }
  }
  return { ok: false, message: 'Authentication failed: check the API key.', details: { latencyMs, fix: 'Paste a valid key from platform.openai.com/api-keys in Edit, save, then test again.' } }
}

export const seed: PreviewSeed = {
  api: (flags) => {
    const providerFlag = flags.get('providers')
    const presetFlag = flags.get('presets')
    let providers: Promise<ProviderConfig[]> | undefined
    const store = (): Promise<ProviderConfig[]> => (providers ??= initialProviders(flags))
    let presets: Preset[] | undefined
    const presetList = (): Preset[] =>
      (presets ??=
        presetFlag === 'many' || presetFlag === 'fail'
          ? [
              { id: 'pr1', name: 'Code review', providerId: 'anthropic', model: 'claude-opus-5-5', systemPrompt: 'You review diffs the way a careful senior engineer would: correctness first, then clarity. Quote the line you mean.', params: { maxOutputTokens: 8192 } },
              { id: 'pr2', name: 'Quick questions', providerId: 'openai', model: 'gpt-5.5', systemPrompt: '', params: { maxOutputTokens: 1024 } },
              {
                id: 'pr3',
                name: 'Long-form technical documentation and API reference writing for the platform team',
                providerId: 'nvidia',
                model: 'deepseek-ai/deepseek-r1',
                systemPrompt: 'Write reference documentation for internal services. Describe every parameter, its type, its default, what happens when it is omitted, and at least one failure mode. Prefer short sentences and concrete examples over summaries.',
                params: { maxOutputTokens: 16000 }
              },
              { id: 'pr4', name: 'Release notes', providerId: 'retired', model: 'gpt-4.1', systemPrompt: '', params: { maxOutputTokens: 2048 } }
            ]
          : [])
    const presetsLocked = (): void => {
      if (presetFlag === 'fail') throw new Error('Error: The preset store is locked by another process. Close other copies of Cubex, then save again.')
    }

    const methods: Partial<CubexAPI> = {
      listProviders: async () => [...(await store())],
      saveProvider: async (cfg, secret) => {
        if (providerFlag === 'savefail') throw new Error('Error: Could not securely store the API key: OS encryption is unavailable on this system.')
        const list = await store()
        const saved: ProviderConfig = { ...cfg, ...(secret ? { credentialRef: cfg.credentialRef ?? `cred_${cfg.id}` } : {}) }
        const index = list.findIndex((p) => p.id === saved.id)
        if (index >= 0) list[index] = saved
        else list.push(saved)
        return saved
      },
      deleteProvider: async (id) => {
        const list = await store()
        const index = list.findIndex((p) => p.id === id)
        if (index >= 0) list.splice(index, 1)
      },
      testProvider: async (id) => {
        await sleep(providerFlag === 'testslow' ? 6000 : 900)
        const cfg = (await store()).find((p) => p.id === id)
        if (!cfg) return { ok: false, message: 'This provider is turned off. Turn it on, then test again.' }
        if (!cfg.enabled) return { ok: false, message: 'This provider is turned off. Turn it on, then test again.' }
        if (providerFlag === 'testfail') return failureFor(cfg)
        const { seedModels } = await import('../previewSeed')
        const models = seedModels[id]?.length ?? 14
        const azure = cfg.kind === 'openai-compat' && cfg.apiMode === 'azure'
        return {
          ok: true,
          details: {
            endpoint: cfg.baseUrl ?? (azure ? `https://${cfg.azureResource}.openai.azure.com` : 'https://api.openai.com/v1'),
            latencyMs: latencyOf(id),
            checked: azure ? 'Asked the resource for its models with this key.' : (CHECKED[cfg.kind] ?? 'Asked the endpoint for its model list.'),
            models,
            modelNoun: azure ? 'deployments' : 'models',
            ...(cfg.defaultModel ? { defaultModelListed: !cfg.defaultModel.startsWith('gpt-9') } : {})
          }
        }
      },
      refreshModels: async (id): Promise<ModelRefreshResult> => {
        await sleep(600)
        const { seedModels } = await import('../previewSeed')
        const known = seedModels[id]?.length ?? 14
        if (providerFlag === 'testfail') {
          return { ok: false, count: known, message: 'Not reachable at https://api.example.com/v1: fetch failed', fix: 'Check the address in Edit and your internet connection, then test again.' }
        }
        return { ok: true, count: known }
      },
      listPresets: async () => [...presetList()],
      savePreset: async (preset) => {
        presetsLocked()
        const list = presetList()
        const index = list.findIndex((p) => p.id === preset.id)
        if (index >= 0) list[index] = preset
        else list.push(preset)
        return preset
      },
      deletePreset: async (id) => {
        presetsLocked()
        const list = presetList()
        const index = list.findIndex((p) => p.id === id)
        if (index >= 0) list.splice(index, 1)
      }
    }
    return methods
  }
}
