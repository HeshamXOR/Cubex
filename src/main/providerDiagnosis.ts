import type { ProviderConfig } from '@core/types'
import { presetFor } from '@shared/providerPresets'

/**
 * Words for the result of a connection test: what the adapter actually did to find
 * out (so a success is never read as more than it proved), and, when it failed,
 * the one thing to try next. Adapters report in their own terse words; this keeps
 * that out of the screen.
 */

const LOCAL_KINDS: ReadonlySet<string> = new Set(['ollama', 'lmstudio', 'llamacpp'])

const isAzure = (cfg: ProviderConfig): boolean => cfg.kind === 'openai-compat' && cfg.apiMode === 'azure'

const isLocal = (cfg: ProviderConfig): boolean => LOCAL_KINDS.has(cfg.kind) || (cfg.accessType === 'local' && !isAzure(cfg))

/** What `validateConfiguration` does for this kind of provider, as a sentence. */
export function connectionChecked(cfg: ProviderConfig): string {
  if (isAzure(cfg)) return 'Asked the resource for its models with this key.'
  switch (cfg.kind) {
    case 'openai':
    case 'gemini':
      return 'Listed the models this key can use.'
    case 'anthropic':
      return 'Sent a one-token message with this key.'
    case 'openai-compat':
    case 'lmstudio':
    case 'llamacpp':
      return 'Asked the endpoint for its model list.'
    case 'ollama':
      return 'Asked the server for its version.'
    case 'custom':
      return 'Reached the endpoint. The request and response mapping were not tested.'
    default:
      return 'The offline demo needs no connection.'
  }
}

/** What an Azure resource lists is the deployments the person named, not a catalog. */
export function modelNoun(cfg: ProviderConfig): 'models' | 'deployments' {
  return isAzure(cfg) ? 'deployments' : 'models'
}

/** One sentence on what to do after a failed test, chosen from what the adapter reported. */
export function connectionFix(cfg: ProviderConfig, message: string | undefined): string {
  const text = (message ?? '').toLowerCase()
  const keyPage = presetFor(cfg)?.keyPage

  if (/no api key|no key/.test(text)) return 'Add an API key in Edit, save, then test again.'
  if (/authentication|unauthorized|invalid api key|incorrect api key|\b401\b/.test(text)) {
    if (isAzure(cfg)) {
      return 'Copy a key from Keys and Endpoint in the Azure portal, paste it in Edit and save. Check that the resource name matches the portal.'
    }
    return `Paste a valid key${keyPage ? ` from ${keyPage}` : ''} in Edit, save, then test again.`
  }
  if (/not reachable|could not reach|cannot reach|econnrefused|enotfound|eai_again|fetch failed|network/.test(text)) {
    if (cfg.kind === 'ollama') return 'Start Ollama, then test again. If it runs on another machine, put its address in Edit.'
    if (cfg.kind === 'lmstudio') return "Start the local server from LM Studio's Developer tab, then test again."
    if (cfg.kind === 'llamacpp') return 'Start llama-server, then test again. The port must match the address in Edit.'
    return isLocal(cfg)
      ? 'Start the server, then test again. Check the address in Edit.'
      : 'Check the address in Edit and your internet connection, then test again.'
  }
  if (/timed out|timeout/.test(text)) return 'The endpoint did not answer in time. Check the address in Edit, then test again.'
  if (/\b429\b|rate limit|quota|too many requests/.test(text)) {
    return 'The provider is limiting this key. Check your plan and usage in its console, wait a minute, then test again.'
  }
  if (/\b403\b|forbidden|permission/.test(text)) {
    return "The key is valid but is not allowed to do this. Check its permissions or project in the provider's console."
  }
  if (/\b404\b|not found/.test(text)) {
    return isAzure(cfg)
      ? 'The resource answered but does not know this route. Check the resource name, and the API version if you set a dated one.'
      : 'The endpoint answered but has no such route. Check the address in Edit; most compatible hosts end it with /v1.'
  }
  if (/mapping|prompt field|no baseurl/.test(text)) return 'Fix the address and field mapping in Edit, then test again.'
  return 'Check the address and key in Edit, then test again.'
}
