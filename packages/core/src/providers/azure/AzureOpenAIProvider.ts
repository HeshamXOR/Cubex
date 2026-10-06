import type { Capability } from '../../types/capabilities'
import { NormalizedAIError } from '../../types/errors'
import type { ModelInfo } from '../../types/model'
import type { AuthMethod, ProviderConfig, ValidationResult } from '../../types/provider'
import type { AIRequest } from '../../types/request'
import { normalizeUnknownError } from '../../errors/normalize'
import { buildAuthHeaders, normalizeBaseUrl } from '../base'
import { OpenAICompatProvider } from '../openai-compat/OpenAICompatProvider'

const DEFAULT_API_VERSION = 'v1'
/** An Azure resource name is a DNS label. The key is sent to this host, so nothing else gets through. */
const RESOURCE_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/
/** The first api-version that accepts `max_completion_tokens` (and, with it, the o-series and GPT-5). */
const MAX_COMPLETION_TOKENS_SINCE = '2024-09-01'

/** Azure deployments of current models take images and tools; a deployment's real limits are declared in `capabilities`. */
const AZURE_CAPS: Capability[] = [
  'text',
  'streaming',
  'system_prompt',
  'multi_turn',
  'tools',
  'structured_output',
  'json_mode',
  'vision',
  'image_input',
  'temperature',
  'stop_sequences',
  'usage_reporting',
  'cancellation'
]

function invalid(message: string): NormalizedAIError {
  return new NormalizedAIError({
    provider: 'azure-openai',
    category: 'INVALID_REQUEST',
    message,
    classification: 'permanent',
    retryable: false
  })
}

/** `https://{resource}.openai.azure.com`, or the base URL override with any pasted route trimmed off. */
function azureOrigin(cfg: ProviderConfig): string {
  const override = cfg.baseUrl?.trim()
  if (override) {
    const url = override.replace(/[?#].*$/, '')
    return normalizeBaseUrl(url.replace(/\/openai(?:\/.*)?$/i, ''), url)
  }
  const resource = cfg.azureResource?.trim()
  if (!resource) throw invalid('Azure OpenAI needs a resource name or a base URL.')
  if (!RESOURCE_NAME.test(resource)) {
    throw invalid(`"${resource}" is not a valid Azure resource name: use letters, digits and hyphens only (not the full address).`)
  }
  return `https://${resource}.openai.azure.com`
}

/** Azure authenticates a key with `api-key`; an Entra ID token is the one case that is a bearer credential. */
function azureAuth(cfg: ProviderConfig): AuthMethod {
  if (cfg.auth.type === 'bearer' || cfg.auth.type === 'oauth') return cfg.auth
  return { type: 'api_key', scheme: 'raw', headerName: 'api-key' }
}

/**
 * Azure OpenAI as a mode of the OpenAI-compatible adapter (`kind: 'openai-compat'`,
 * `apiMode: 'azure'`): the same Chat Completions wire format and stream, routed
 * the Azure way.
 *  - v1 route (the default, `apiVersion` unset or 'v1'):
 *    https://{resource}.openai.azure.com/openai/v1/chat/completions
 *    with the deployment name as `model`;
 *  - dated route (`apiVersion` like '2024-10-21'):
 *    https://{resource}.openai.azure.com/openai/deployments/{deployment}/chat/completions?api-version=...
 * A request's model is the deployment name. Deployments cannot be listed with an
 * API key, so the models are the configured `azureDeployments`.
 */
export class AzureOpenAIProvider extends OpenAICompatProvider {
  private readonly origin: string
  private readonly apiVersion: string
  private readonly v1: boolean

  constructor(cfg: ProviderConfig, secret?: string) {
    const origin = azureOrigin(cfg)
    const apiVersion = cfg.apiVersion?.trim() || DEFAULT_API_VERSION
    const v1 = apiVersion.toLowerCase() === 'v1'
    super({ ...cfg, baseUrl: v1 ? `${origin}/openai/v1` : `${origin}/openai`, auth: azureAuth(cfg) }, secret, 'openai-compat')
    this.origin = origin
    this.apiVersion = apiVersion
    this.v1 = v1
    this.setCapabilities(cfg.capabilities ?? AZURE_CAPS)
  }

  /** Newer models reject `max_tokens`; the v1 route and api-versions from 2024-09-01 take `max_completion_tokens`. */
  private get maxTokensField(): 'max_tokens' | 'max_completion_tokens' {
    const date = /^\d{4}-\d{2}-\d{2}/.exec(this.apiVersion)?.[0]
    return this.v1 || date === undefined || date >= MAX_COMPLETION_TOKENS_SINCE ? 'max_completion_tokens' : 'max_tokens'
  }

  protected override chatTarget(request: AIRequest): { url: string; maxTokensField: 'max_tokens' | 'max_completion_tokens' } {
    const url = this.v1
      ? `${this.baseUrl}/chat/completions`
      : `${this.baseUrl}/deployments/${encodeURIComponent(request.model)}/chat/completions?api-version=${encodeURIComponent(this.apiVersion)}`
    return { url, maxTokensField: this.maxTokensField }
  }

  override async getModels(): Promise<ModelInfo[]> {
    const names = [...(this.cfg.azureDeployments ?? []), ...(this.cfg.defaultModel ? [this.cfg.defaultModel] : [])]
    const seen = new Set<string>()
    const ids = names.map((name) => name.trim()).filter((name) => name.length > 0 && !seen.has(name) && seen.add(name))
    const caps = this.cfg.capabilities ?? AZURE_CAPS
    return ids.map((id) => ({
      id,
      providerId: this.id,
      displayName: id,
      location: 'cloud' as const,
      capabilities: caps,
      modalities: { input: caps.includes('image_input') ? ['text' as const, 'image' as const] : ['text' as const], output: ['text' as const] },
      supportsTools: caps.includes('tools'),
      supportsStructuredOutput: caps.includes('structured_output'),
      supportsReasoning: caps.includes('reasoning'),
      notes: 'Azure deployment'
    }))
  }

  override async validateConfiguration(): Promise<ValidationResult> {
    const url = this.v1 ? `${this.baseUrl}/models` : `${this.baseUrl}/models?api-version=${encodeURIComponent(this.apiVersion)}`
    try {
      const res = await globalThis.fetch(url, { headers: buildAuthHeaders(this.cfg, this.secret), signal: AbortSignal.timeout(8000) })
      if (!res.ok) {
        const error = await this.httpError(res)
        return {
          ok: false,
          message: error.category === 'AUTHENTICATION_ERROR' ? 'Authentication failed: check the API key.' : `Validation failed: ${error.message}`
        }
      }
      return { ok: true, details: { endpoint: this.origin, deployments: (await this.getModels()).length } }
    } catch (err) {
      return { ok: false, message: `Not reachable at ${this.origin}: ${normalizeUnknownError(this.id, err).message}` }
    }
  }
}
