import type { ErrorCategory } from '@core/types'

/**
 * How a failed turn reads in the thread. The raw category is an internal enum
 * ("RATE_LIMIT_ERROR"), so it never reaches the user: each one becomes a plain
 * sentence saying what happened and a second one saying what to do about it.
 * Errors state the problem and the way out; they do not apologize.
 */
export interface ErrorPresentation {
  title: string
  guidance: string
  /** Which recovery to offer beside the message. */
  action: 'retry' | 'compact' | 'providers' | 'none'
}

const PRESENTATION: Record<ErrorCategory, ErrorPresentation> = {
  AUTHENTICATION_ERROR: {
    title: 'The provider rejected the API key',
    guidance: 'Check the key in Providers. It may have been revoked or copied incompletely.',
    action: 'providers'
  },
  AUTHORIZATION_ERROR: {
    title: 'This key cannot use this model',
    guidance: 'The account may lack access or billing for it. Pick another model, or check the provider dashboard.',
    action: 'providers'
  },
  RATE_LIMIT_ERROR: {
    title: 'The provider is rate limiting this key',
    guidance: 'Too many requests or tokens in a short window. Waiting a moment and retrying usually clears it.',
    action: 'retry'
  },
  INVALID_REQUEST: {
    title: 'The provider rejected the request',
    guidance: 'Something in the request is not valid for this model. The detail below is the provider verbatim.',
    action: 'none'
  },
  MODEL_NOT_FOUND: {
    title: 'That model is not available on this provider',
    guidance: 'It may have been renamed or retired. Choose another model for this session.',
    action: 'providers'
  },
  CONTEXT_LENGTH: {
    title: 'The conversation no longer fits in the model context',
    guidance: 'Summarize the earlier messages to free room, or start a new session for the next piece of work.',
    action: 'compact'
  },
  CONTENT_POLICY: {
    title: 'The provider declined to answer this',
    guidance: 'Its content filter stopped the request. Rephrasing the ask usually gets past it.',
    action: 'none'
  },
  NETWORK_ERROR: {
    title: 'Cubex could not reach the provider',
    guidance: 'Check the connection, and any proxy or firewall between this machine and the API.',
    action: 'retry'
  },
  TIMEOUT: {
    title: 'The model did not respond in time',
    guidance: 'The request may be large, or the provider slow right now. Retrying often works; a smaller request is more reliable.',
    action: 'retry'
  },
  SERVER_ERROR: {
    title: 'The provider returned a server error',
    guidance: 'The fault is on their side and usually brief. Retry in a moment.',
    action: 'retry'
  },
  STREAM_ERROR: {
    title: 'The response stopped part way',
    guidance: 'The connection dropped mid answer. Retry to generate it again.',
    action: 'retry'
  },
  TOOL_ERROR: {
    title: 'A tool call could not be completed',
    guidance: 'The detail below says which one and why.',
    action: 'retry'
  },
  LOCAL_RUNTIME_ERROR: {
    title: 'The local runtime could not serve this model',
    guidance: 'Check that the runtime is still running in Local models, then retry.',
    action: 'retry'
  },
  INSUFFICIENT_MEMORY: {
    title: 'Not enough memory to run this model',
    guidance: 'Close other work, lower the context length, or pick a smaller quantization in Local models.',
    action: 'none'
  },
  UNSUPPORTED_FORMAT: {
    title: 'This model cannot take one of the attachments',
    guidance: 'Remove it, or switch to a model that accepts that kind of input.',
    action: 'none'
  },
  CANCELLED: {
    title: 'The turn was stopped',
    guidance: 'Nothing was lost. Send again when you are ready.',
    action: 'retry'
  },
  UNKNOWN: {
    title: 'The turn failed',
    guidance: 'The detail below is what the provider reported.',
    action: 'retry'
  }
}

export function presentError(category: ErrorCategory): ErrorPresentation {
  return PRESENTATION[category] ?? PRESENTATION.UNKNOWN
}
