import type { Capability } from './capabilities'
import type { AIRequest, RequestOptions } from './request'
import type { AIResponse } from './response'
import type { AIStreamEvent } from './stream'
import type { ModelInfo } from './model'

/** Kinds of providers/runtimes the harness knows how to instantiate. */
export type ProviderKind =
  | 'openai'
  | 'anthropic'
  | 'openai-compat'
  | 'custom'
  | 'ollama'
  | 'llamacpp'
  | 'lmstudio'
  | 'mock'
  | 'mock-local'

/**
 * The access model matters: a consumer subscription does NOT imply developer API
 * access. Adapters use official methods only.
 */
export type AccessType = 'api' | 'oauth' | 'subscription' | 'local'

export type AuthMethod =
  | { type: 'none' }
  | { type: 'api_key'; headerName?: string; scheme?: 'bearer' | 'raw' | 'x-api-key' }
  | { type: 'bearer' }
  | { type: 'oauth'; provider: string; scopes?: string[] }
  | { type: 'env'; varName: string }
  | { type: 'custom_headers' }

export interface ValidationResult {
  ok: boolean
  message?: string
  /** Structured detail for the UI, e.g. resolved endpoint or model count. */
  details?: Record<string, unknown>
}

/**
 * Persisted provider configuration. Contains NO raw secrets — only a reference
 * (`credentialRef`) to a value in the OS-encrypted credential store.
 */
export interface ProviderConfig {
  id: string
  kind: ProviderKind
  name: string
  accessType: AccessType
  baseUrl?: string
  /** e.g. 'responses' | 'chat_completions' for OpenAI-style APIs. */
  apiMode?: string
  apiVersion?: string
  auth: AuthMethod
  /** Opaque id used to look up the secret; never the secret itself. */
  credentialRef?: string
  /** Static extra headers (values may reference secrets by ref, resolved at call time). */
  headers?: Record<string, string>
  /** Manually declared or auto-detected capability overrides. */
  capabilities?: Capability[]
  defaultModel?: string
  /** For custom providers: request/response mapping (see custom adapter). */
  mapping?: CustomProviderMapping
  enabled: boolean
}

/** Declarative mapping for the generic Custom provider. */
export interface CustomProviderMapping {
  method?: 'POST' | 'GET'
  /** Dot-path in the request body where messages/prompt go. */
  promptField?: string
  modelField?: string
  streamField?: string
  /** Dot-path(s) in the response to extract text. */
  responseTextPath?: string
  /** Whether the endpoint speaks SSE. */
  sse?: boolean
  /** 'openai' | 'anthropic' | 'rest' — shape family for translation. */
  shape?: 'openai' | 'anthropic' | 'rest'
}

/**
 * The single contract every cloud provider and local runtime implements.
 * The rest of the app depends only on this.
 */
export interface AIProvider {
  readonly id: string
  readonly name: string
  readonly kind: ProviderKind

  getModels(): Promise<ModelInfo[]>
  sendMessage(request: AIRequest, options?: RequestOptions): Promise<AIResponse>
  streamMessage(request: AIRequest, options?: RequestOptions): AsyncIterable<AIStreamEvent>
  supports(capability: Capability): boolean
  validateConfiguration(): Promise<ValidationResult>
}
