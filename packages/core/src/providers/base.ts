import type { Capability } from '../types/capabilities'
import type { AIProvider, ProviderConfig, ProviderKind, ValidationResult } from '../types/provider'
import type { AIRequest, RequestOptions } from '../types/request'
import type { AIResponse } from '../types/response'
import type { AIStreamEvent } from '../types/stream'
import type { ModelInfo } from '../types/model'
import { StreamAccumulator } from '../streaming/accumulator'

/**
 * Base class providing shared plumbing: capability checks and a default
 * `sendMessage` implemented by draining `streamMessage` (adapters can override
 * for a true non-streaming call).
 */
export abstract class BaseProvider implements AIProvider {
  abstract readonly id: string
  abstract readonly name: string
  abstract readonly kind: ProviderKind

  protected declaredCapabilities: Set<Capability> = new Set()

  abstract getModels(): Promise<ModelInfo[]>
  abstract streamMessage(request: AIRequest, options?: RequestOptions): AsyncIterable<AIStreamEvent>
  abstract validateConfiguration(): Promise<ValidationResult>

  supports(capability: Capability): boolean {
    return this.declaredCapabilities.has(capability)
  }

  setCapabilities(caps: Capability[]): void {
    this.declaredCapabilities = new Set(caps)
  }

  /** Default: collect the stream into a single response. */
  async sendMessage(request: AIRequest, options?: RequestOptions): Promise<AIResponse> {
    const acc = new StreamAccumulator(this.id, request.model)
    for await (const ev of this.streamMessage({ ...request, stream: true }, options)) {
      if (ev.type === 'completed') return ev.response
      if (ev.type === 'error') throw ev.error
      acc.push(ev)
    }
    return acc.finalize()
  }
}

/** Resolve an API base URL, trimming a trailing slash. */
export function normalizeBaseUrl(url: string | undefined, fallback: string): string {
  const base = (url ?? fallback).trim()
  return base.endsWith('/') ? base.slice(0, -1) : base
}

/** Build auth headers from a provider config + resolved secret. */
export function buildAuthHeaders(cfg: ProviderConfig, secret?: string): Record<string, string> {
  const headers: Record<string, string> = { ...(cfg.headers ?? {}) }
  const auth = cfg.auth
  switch (auth.type) {
    case 'api_key': {
      if (!secret) break
      const scheme = auth.scheme ?? 'bearer'
      if (scheme === 'bearer') headers['Authorization'] = `Bearer ${secret}`
      else if (scheme === 'x-api-key') headers['x-api-key'] = secret
      else headers[auth.headerName ?? 'Authorization'] = secret
      break
    }
    case 'bearer':
      if (secret) headers['Authorization'] = `Bearer ${secret}`
      break
    case 'env':
    case 'oauth':
      if (secret) headers['Authorization'] = `Bearer ${secret}`
      break
    case 'custom_headers':
    case 'none':
    default:
      break
  }
  return headers
}
