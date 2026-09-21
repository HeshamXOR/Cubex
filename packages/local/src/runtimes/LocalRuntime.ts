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

export interface PullProgressUpdate {
  status: string
  completedBytes?: number
  totalBytes?: number
  speedBps?: number
  etaSeconds?: number
  done: boolean
  error?: string
}

export interface LocalRuntime {
  readonly id: string
  readonly name: string
  detect(): Promise<RuntimeDetection>
  listModels(): Promise<LocalModelEntry[]>
  start?(): Promise<void>
  stop?(): Promise<void>
  pull?(modelId: string, onProgress: (p: PullProgressUpdate) => void, signal?: AbortSignal): Promise<void>
  deleteModel?(modelId: string): Promise<void>
}
