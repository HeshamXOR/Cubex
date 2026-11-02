import { createHash } from 'node:crypto'
import { createProvider } from '@core/providers'
import type { AIProvider, AIRequest, ProviderConfig, ProviderKind } from '@core/types'
import type { RunConfig, TaskSpec } from './types'
import { createStubProvider } from './stubProvider'

const KINDS: ProviderKind[] = ['openai-compat', 'openai', 'anthropic', 'gemini', 'ollama', 'llamacpp', 'lmstudio', 'custom']

/** What the environment says about the model under test. The key stays here: nothing else in the run holds it. */
export interface EvalTarget {
  kind: string
  model: string
  baseUrl?: string
  effort?: string
  /** Builds the provider for one run of a task, given the workspace the run uses. */
  providerFor(task: TaskSpec, workspace: string): AIProvider
}

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined

/** The model to test, from CUBEX_EVAL_KIND / _BASE_URL / _API_KEY / _MODEL (and _EFFORT, _PROVIDER_JSON). */
export function targetFromEnv(): EvalTarget {
  const kind = env('CUBEX_EVAL_KIND')
  if (!kind) {
    throw new Error(
      'Set CUBEX_EVAL_KIND (openai-compat, openai, anthropic, gemini or stub), CUBEX_EVAL_MODEL, and for a real provider CUBEX_EVAL_API_KEY ' +
      'and, where the provider has no fixed address, CUBEX_EVAL_BASE_URL. `npm run eval:app` fills them in from a provider saved in Cubex.'
    )
  }
  const effort = env('CUBEX_EVAL_EFFORT')
  if (kind === 'stub') {
    return { kind, model: env('CUBEX_EVAL_MODEL') ?? 'stub', ...(effort ? { effort } : {}), providerFor: (task, workspace) => createStubProvider(task, workspace) }
  }
  if (!KINDS.includes(kind as ProviderKind)) throw new Error(`CUBEX_EVAL_KIND "${kind}" is not one of ${[...KINDS, 'stub'].join(', ')}.`)
  const model = env('CUBEX_EVAL_MODEL')
  if (!model) throw new Error('Set CUBEX_EVAL_MODEL to the model id to test.')
  const apiKey = env('CUBEX_EVAL_API_KEY')
  // The run's shell commands and checks must never see the key; it lives in this closure only.
  delete process.env.CUBEX_EVAL_API_KEY
  const baseUrl = env('CUBEX_EVAL_BASE_URL')
  // The rest of a provider saved in the app (API mode, capabilities, headers), when eval:app passes it on.
  let saved: Partial<ProviderConfig> = {}
  const json = env('CUBEX_EVAL_PROVIDER_JSON')
  if (json) {
    try { saved = JSON.parse(json) as Partial<ProviderConfig> } catch { throw new Error('CUBEX_EVAL_PROVIDER_JSON is not valid JSON.') }
  }
  const cfg: ProviderConfig = {
    auth: { type: 'api_key' }, accessType: 'api', ...saved,
    id: 'eval', name: 'Eval', kind: kind as ProviderKind, enabled: true, defaultModel: model, ...(baseUrl ? { baseUrl } : {})
  }
  delete cfg.credentialRef
  return { kind, model, ...(baseUrl ? { baseUrl } : {}), ...(effort ? { effort } : {}), providerFor: () => createProvider(cfg, apiKey) }
}

export function configOf(target: EvalTarget, tasks: string[], repeat: number, concurrency: number): RunConfig {
  return { kind: target.kind, ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}), model: target.model, ...(target.effort ? { effort: target.effort } : {}), repeat, concurrency, tasks }
}

/** What a run learns from the requests it sends: a fingerprint of the system prompt and the tools offered. */
export interface RequestProbe {
  promptHash?: string
  toolsOffered?: string[]
}

/** The same provider, noting the first request of the run. The workspace path (different every run) is left out of the hash. */
export function probed(provider: AIProvider, probe: RequestProbe, workspace: string): AIProvider {
  return new Proxy(provider, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown
      if (property !== 'streamMessage' || typeof value !== 'function') return typeof value === 'function' ? value.bind(target) : value
      return (request: AIRequest, ...rest: unknown[]) => {
        if (probe.promptHash === undefined) {
          probe.promptHash = createHash('sha1').update(String(request.system ?? '').split(workspace).join('<workspace>')).digest('hex').slice(0, 8)
          probe.toolsOffered = (request.tools ?? []).map((tool) => tool.name)
        }
        return (value as (...args: unknown[]) => unknown).call(target, request, ...rest)
      }
    }
  }) as AIProvider
}
