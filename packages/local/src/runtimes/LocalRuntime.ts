/**
 * Modular local-runtime abstraction. Each runtime (Ollama, llama.cpp, LM Studio,
 * custom) implements this so the app can detect, list, start/stop, pull and
 * delete models uniformly. The app never assumes a runtime is installed.
 */

export interface LocalModelEntry {
  id: string
  name: string
  runtime: string
  sizeBytes?: number
  quantization?: string
  parameterCount?: number
  family?: string
  location?: string
  lastUsed?: number
}

export interface RuntimeDetection {
  installed: boolean
  running: boolean
  version?: string
  endpoint?: string
  error?: string
}

/** Coarse stage of a pull, so a UI can pick a label or icon without parsing `status`. */
export type PullPhase =
  | 'queued'
  | 'preparing'
  | 'downloading'
  | 'verifying'
  | 'finalizing'
  | 'done'
  | 'error'
  | 'cancelled'

/** Why a pull failed, so a UI can offer the right next step. */
export type PullErrorCode = 'runtime_unreachable' | 'disk_space' | 'unsupported' | 'failed'

export interface PullProgressUpdate {
  status: string
  completedBytes?: number
  totalBytes?: number
  speedBps?: number
  etaSeconds?: number
  done: boolean
  error?: string
  /** Additive: coarse stage (see PullPhase). */
  phase?: PullPhase
  /** Additive: 1-based place in the queue while waiting for a free download slot. */
  queuePosition?: number
  /** Additive: the file being fetched when a model is made of several GGUF parts. */
  fileName?: string
  fileIndex?: number
  fileCount?: number
  /** Additive, on the final event of a direct download: where the model now lives. */
  path?: string
  /** Additive: true when the downloaded file matched a published SHA-256. */
  verified?: boolean
  sha256?: string
  /** Additive: whole seconds since the last byte arrived, set by the pull manager once a download stalls. */
  stalledForSeconds?: number
  /** Additive: why the pull failed, set together with `error`. */
  errorCode?: PullErrorCode
}

/** How big a download will be, so the disk can be checked before it starts. */
export interface PullEstimate {
  /** Bytes the whole model takes on disk. */
  totalBytes: number
  /** Bytes still to fetch: the total less what is already on disk, finished or partial. */
  remainingBytes: number
  /** Exact from the runtime's registry, or approximate from the built-in catalog. */
  source: 'registry' | 'catalog'
}

export interface LocalRuntime {
  readonly id: string
  readonly name: string
  /** What a person can do about a full disk, as a sentence in this runtime's own terms. */
  readonly diskAdvice?: string
  detect(): Promise<RuntimeDetection>
  listModels(): Promise<LocalModelEntry[]>
  start?(): Promise<void>
  stop?(): Promise<void>
  pull?(modelId: string, onProgress: (p: PullProgressUpdate) => void, signal?: AbortSignal): Promise<void>
  /** The size of a pull before it starts; undefined when the runtime cannot tell. */
  estimatePull?(modelId: string, signal?: AbortSignal): Promise<PullEstimate | undefined>
  /** The folder on this PC where downloads land; undefined when the runtime is elsewhere or the folder is unknown. */
  modelsDir?(): string | undefined
  deleteModel?(modelId: string): Promise<void>
}
