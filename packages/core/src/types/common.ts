/**
 * Primitive shared types used across the unified AI model.
 * Kept dependency-free so `@core` stays pure TypeScript.
 */

export type JSONPrimitive = string | number | boolean | null
export type JSONValue = JSONPrimitive | JSONValue[] | { [key: string]: JSONValue }
export type JSONObject = { [key: string]: JSONValue }

/** A minimal JSON Schema shape sufficient for tool input schemas / structured output. */
export interface JSONSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  properties?: Record<string, JSONSchema>
  items?: JSONSchema | JSONSchema[]
  required?: string[]
  enum?: JSONValue[]
  description?: string
  additionalProperties?: boolean | JSONSchema
  [key: string]: unknown
}

export type Modality = 'text' | 'image' | 'audio' | 'video' | 'file' | 'embedding'

/**
 * Common quantization formats. Open-ended (`string`) because ecosystems invent
 * new variants constantly (GGUF Q-types, AWQ, GPTQ, etc.).
 */
export type Quantization =
  | 'FP32'
  | 'FP16'
  | 'BF16'
  | 'INT8'
  | 'INT4'
  | 'Q8_0'
  | 'Q6_K'
  | 'Q5_K_M'
  | 'Q5_K_S'
  | 'Q4_K_M'
  | 'Q4_K_S'
  | 'Q4_0'
  | 'Q3_K_M'
  | 'Q2_K'
  | 'AWQ'
  | 'GPTQ'
  | (string & {})

export type ExecutionPath = 'cloud' | 'local'

/** Byte-count helpers so estimates stay in explicit units. */
export const BYTES_PER_GB = 1024 * 1024 * 1024
export const BYTES_PER_MB = 1024 * 1024
