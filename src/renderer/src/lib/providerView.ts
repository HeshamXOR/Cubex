import type { ModelRefreshResult } from '../../../shared/ipc'
import { endpointLabel, presetFor, PROVIDER_PRESETS } from '../../../shared/providerPresets'
import type { ProviderConfig, ProviderKind, ValidationResult } from '@core/types'

/** What a person calls the kind of provider when its own name does not already say it. */
export function kindLabel(cfg: Pick<ProviderConfig, 'kind' | 'apiMode'>): string {
  if (cfg.kind === 'mock' || cfg.kind === 'mock-local') return 'Offline demo'
  if (cfg.kind === 'openai-compat' && cfg.apiMode === 'azure') return 'Azure OpenAI'
  if (cfg.kind === 'openai-compat') return 'OpenAI-compatible'
  if (cfg.kind === 'custom') return 'Custom JSON API'
  return PROVIDER_PRESETS.find((p) => p.kind === cfg.kind && !p.azure)?.label ?? cfg.kind
}

const normalize = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '')

/** True when two labels say the same thing: "OpenAI" and "openai", "LM Studio" and "LM-Studio". */
export function sameLabel(a: string, b: string): boolean {
  return normalize(a) === normalize(b)
}

export type AccessMode = 'cloud' | 'local' | 'offline'

export function accessMode(cfg: ProviderConfig): AccessMode {
  if (cfg.kind === 'mock' || cfg.kind === 'mock-local') return 'offline'
  if (cfg.kind === 'ollama' || cfg.kind === 'lmstudio' || cfg.kind === 'llamacpp') return 'local'
  const azure = cfg.kind === 'openai-compat' && cfg.apiMode === 'azure'
  return (cfg.kind === 'custom' || cfg.kind === 'openai-compat') && cfg.accessType === 'local' && !azure ? 'local' : 'cloud'
}

export const ACCESS_LABEL: Record<AccessMode, string> = { cloud: 'Cloud', local: 'Local', offline: 'Offline' }

export type KeyState = 'saved' | 'missing' | 'optional' | 'none'

/** Whether a provider has a key, as far as the window can tell: only a saved reference, never the key itself. */
export function keyState(cfg: ProviderConfig): KeyState {
  if (cfg.auth.type === 'none') return 'none'
  if (cfg.credentialRef) return 'saved'
  const required = accessMode(cfg) === 'cloud' && (presetFor(cfg)?.keyRequired ?? true)
  return required ? 'missing' : 'optional'
}

export interface RowFacts {
  /** Only when it adds something: "OpenAI-compatible" under "NVIDIA", never "Anthropic" under "Anthropic". */
  kind?: string
  endpoint?: string
  model?: string
}

export function rowFacts(cfg: ProviderConfig): RowFacts {
  const kind = kindLabel(cfg)
  const endpoint = endpointLabel(cfg)
  const model = cfg.defaultModel?.trim()
  return {
    ...(sameLabel(kind, cfg.name) ? {} : { kind }),
    ...(endpoint && !sameLabel(endpoint, cfg.name) ? { endpoint } : {}),
    ...(model ? { model } : {})
  }
}

export type ConnectionState = 'testing' | 'ok' | 'failed' | 'needs-key' | 'disabled' | 'untested'

/** The one state a row shows. A test in progress or a result beats what the configuration alone suggests. */
export function connectionState(cfg: ProviderConfig, status: { testing?: boolean; result?: ValidationResult }): ConnectionState {
  if (status.testing) return 'testing'
  if (!cfg.enabled) return 'disabled'
  if (status.result) return status.result.ok ? 'ok' : 'failed'
  return keyState(cfg) === 'missing' ? 'needs-key' : 'untested'
}

export interface ResultFacts {
  ok: boolean
  /** The headline: what happened. */
  title: string
  message?: string
  fix?: string
  latency?: string
  models?: string
  checked?: string
  endpoint?: string
  /** Set when the check passed but the default model is not one the provider offers. */
  defaultModelMissing?: boolean
}

const asText = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
const asCount = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined)

/** Count and noun: "1 model", "42 models", "2 deployments". */
export function countLabel(count: number, noun: 'model' | 'deployment' = 'model'): string {
  return `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`
}

export function describeResult(result: ValidationResult, provider: Pick<ProviderConfig, 'kind' | 'mapping'>): ResultFacts {
  const details = result.details ?? {}
  const latencyMs = asCount(details.latencyMs)
  const models = asCount(details.models)
  const noun = details.modelNoun === 'deployments' ? 'deployment' : 'model'
  const mappingUntested = provider.kind === 'custom' && (!provider.mapping?.shape || provider.mapping.shape === 'rest')
  const facts: ResultFacts = {
    ok: result.ok,
    title: result.ok ? 'Connected' : 'Could not connect',
    ...(result.ok ? {} : { message: result.message?.trim() || 'The provider did not answer.' }),
    ...(asText(details.fix) ? { fix: asText(details.fix)! } : {}),
    ...(latencyMs !== undefined ? { latency: latencyMs < 1000 ? `${Math.round(latencyMs)} ms` : `${(latencyMs / 1000).toFixed(1)} s` } : {}),
    ...(models !== undefined ? { models: `${countLabel(models, noun)} available` } : {}),
    ...(asText(details.checked) ? { checked: asText(details.checked)! } : mappingUntested && result.ok ? { checked: 'Reached the endpoint. The request and response mapping were not tested.' } : {}),
    ...(asText(details.endpoint) ? { endpoint: asText(details.endpoint)! } : {}),
    ...(details.defaultModelListed === false ? { defaultModelMissing: true } : {})
  }
  if (result.ok && result.message) facts.message = result.message
  return facts
}

/** The outcome of a model-list refresh as a sentence for a callout. */
export function describeRefresh(refresh: ModelRefreshResult, noun: 'model' | 'deployment' = 'model'): { title: string; body: string; fix?: string } {
  if (refresh.ok) return { title: 'Model list refreshed', body: `${countLabel(refresh.count, noun)} available.` }
  return {
    title: 'Could not refresh the model list',
    body: `${refresh.message ?? 'The provider did not answer.'}${refresh.count > 0 ? ` Cubex keeps the ${countLabel(refresh.count, noun)} it already knew.` : ''}`,
    ...(refresh.fix ? { fix: refresh.fix } : {})
  }
}

const DNS_LABEL = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/

export function isCustomRest(cfg: ProviderConfig): boolean {
  return cfg.kind === 'custom' && (!cfg.mapping?.shape || cfg.mapping.shape === 'rest')
}

export const isMock = (kind: ProviderKind): boolean => kind === 'mock' || kind === 'mock-local'
export const isAzure = (cfg: ProviderConfig): boolean => cfg.kind === 'openai-compat' && cfg.apiMode === 'azure'

/** What is wrong with the form, in a sentence that says how to fix it; undefined when it can be saved. */
export function validateProvider(cfg: ProviderConfig): string | undefined {
  if (!cfg.name.trim()) return 'Enter a display name.'
  if (isAzure(cfg)) {
    const resource = cfg.azureResource?.trim() ?? ''
    if (!resource) return 'Enter the Azure resource name: the part before .openai.azure.com in its address.'
    if (!DNS_LABEL.test(resource)) return 'The resource name holds letters, digits and hyphens only. Enter just the name, not the full address.'
    if ((cfg.azureDeployments ?? []).length === 0 && !cfg.defaultModel?.trim()) {
      return 'Name at least one deployment. Azure uses the deployment name where other providers use a model name.'
    }
    return undefined
  }
  if (!isMock(cfg.kind)) {
    try {
      const url = new URL(cfg.baseUrl?.trim() ?? '')
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Use an http:// or https:// address.'
    } catch {
      return 'Enter a valid address, including http:// or https://.'
    }
  }
  if (isCustomRest(cfg)) {
    if (cfg.mapping?.method !== 'GET' && !cfg.mapping?.promptField?.trim()) return 'Set a prompt field so the custom API receives your messages.'
    if (!cfg.defaultModel?.trim()) return 'Set a default model for this custom JSON endpoint.'
  }
  return undefined
}

/** Deployment names as typed: separated by commas, spaces or new lines, without repeats. */
export function parseDeployments(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((name) => name.trim()).filter(Boolean))]
}
