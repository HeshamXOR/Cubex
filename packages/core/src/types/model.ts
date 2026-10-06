import type { Capability } from './capabilities'
import type { ExecutionPath, Modality, Quantization } from './common'
import type { MemoryEstimate } from './estimation'
import type { ReasoningEffort } from './request'

/** Where a price came from; drives the cost source shown next to a figure. */
export type PricingSource = 'builtin' | 'catalog' | 'user'

export interface ModelPricing {
  currency: string
  inputPerMTok?: number
  outputPerMTok?: number
  cachedInputPerMTok?: number
  /** Writing a prompt-cache entry (Anthropic bills the 5-minute write at 1.25x input). */
  cacheWritePerMTok?: number
  /** Where these numbers came from. Absent means the built-in table. */
  source?: PricingSource
  /** Free-form for providers that price differently. */
  notes?: string
}

export interface ModalitySupport {
  input: Modality[]
  output: Modality[]
}

/**
 * Unified model metadata. Capabilities are never hard-coded around a single
 * provider; adapters return this dynamically where the API allows, and it can be
 * overridden manually.
 */
export interface ModelInfo {
  id: string
  providerId: string
  displayName: string
  family?: string
  location: ExecutionPath
  capabilities: Capability[]
  modalities: ModalitySupport
  contextWindow?: number
  /** Cap on input tokens when it is lower than the window (catalog `limit.input`). */
  maxInputTokens?: number
  maxOutputTokens?: number
  supportsTools: boolean
  supportsStructuredOutput: boolean
  supportsReasoning: boolean
  /**
   * The effort levels this model accepts, lowest first, when its provider or the model catalog says so.
   * An empty list means it reasons but has no effort setting. Absent means nobody has said.
   */
  reasoningEfforts?: ReasoningEffort[]
  /** 1M context is available but gated behind a provider beta the user opts into. */
  longContextBeta?: boolean
  pricing?: ModelPricing

  // --- Local/open-source extras ---
  organization?: string
  parameterCount?: number // in billions
  quantization?: Quantization
  architecture?: string
  license?: string
  diskSizeBytes?: number
  downloadSizeBytes?: number
  supportedRuntimes?: string[]
  downloads?: number // popularity metric where available
  estimatedMemory?: MemoryEstimate
  /** Mixture-of-experts: parameters used per token, in billions. Memory still holds all of them. */
  activeParameterCount?: number
  /** Transformer shape for KV-cache math; when omitted, a size-class guess is used. */
  attention?: {
    layers: number
    kvHeads: number
    headDim: number
    /** Layers that only attend to a sliding window, and that window in tokens. */
    slidingLayers?: number
    slidingWindow?: number
  }
  /** Where to get it: an Ollama library tag and/or Hugging Face GGUF repositories. */
  sources?: {
    ollama?: string
    huggingface?: Array<{ repo: string; quant?: string; file?: string; sizeBytes?: number }>
  }
  notes?: string
}

/** Filters for the open-source model browser. */
export interface ModelBrowserFilter {
  query?: string
  task?: 'text' | 'vision' | 'coding' | 'reasoning' | 'embeddings' | 'audio' | 'multimodal'
  minParams?: number
  maxParams?: number
  quantization?: Quantization[]
  minContext?: number
  runtime?: string
  hardwareCompatibleOnly?: boolean
}
