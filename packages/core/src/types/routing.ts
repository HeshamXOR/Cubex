import type { SamplingParams, TimeoutConfig } from './request'
import type { RetryPolicy } from './retry'
import type { NormalizedAIError } from './errors'

export interface RoutingTarget {
  providerId: string
  model: string
  params?: SamplingParams
}

/**
 * A routing policy binds a primary target, an optional ordered fallback chain,
 * and the retry/timeout behavior. Fallback is OFF unless explicitly enabled — the
 * harness never silently switches providers.
 */
export interface RoutingPolicy {
  primary: RoutingTarget
  fallbacks: RoutingTarget[]
  fallbackEnabled: boolean
  retry: RetryPolicy
  timeout: TimeoutConfig
}

/** Lifecycle events emitted by the gateway so the UI can show retries/fallbacks. */
export type GatewayEvent =
  | { type: 'attempt_start'; target: RoutingTarget; attempt: number }
  | {
      type: 'attempt_error'
      target: RoutingTarget
      attempt: number
      error: NormalizedAIError
      willRetry: boolean
      delayMs?: number
    }
  | { type: 'retry_wait'; target: RoutingTarget; attempt: number; delayMs: number }
  | { type: 'fallback'; from: RoutingTarget; to: RoutingTarget; reason: string }
  | { type: 'final'; target: RoutingTarget; success: boolean }

export type GatewayEventHandler = (event: GatewayEvent) => void
