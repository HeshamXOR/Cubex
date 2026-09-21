import type { Capability } from './capabilities'
import type { ExecutionPath, Modality, Quantization } from './common'
import type { MemoryEstimate } from './estimation'

export interface ModelPricing {
  currency: string
  inputPerMTok?: number
  outputPerMTok?: number
  cachedInputPerMTok?: number
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
  maxOutputTokens?: number
  supportsTools: boolean
  supportsStructuredOutput: boolean
  supportsReasoning: boolean
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
