import type { JSONSchema, JSONValue } from './common'

/**
 * Provider-agnostic tool / function calling abstraction plus a permission model.
 * Tools are never executed automatically without an explicit permission decision.
 */

export interface ToolDefinition {
  name: string
  description?: string
  inputSchema: JSONSchema
}

export type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'tool'; name: string }

/** A finalized tool call requested by the model. */
export interface ToolCall {
  id: string
  name: string
  input: JSONValue
}

export interface ToolResult {
  toolUseId: string
  content: string | JSONValue
  isError?: boolean
  /** Harness-owned display metadata; never forwarded as provider tool content. */
  metadata?: Record<string, JSONValue>
}

/** Permission gate applied before any tool runs. */
export type ToolPermission = 'ask' | 'allow' | 'deny'

export interface ToolPermissionRequest {
  tool: ToolDefinition
  call: ToolCall
}

export type ToolPermissionDecision =
  | { decision: 'allow'; remember?: boolean }
  | { decision: 'deny'; reason?: string; remember?: boolean }

/** A tool the harness can actually execute (registered with a handler). */
export interface ExecutableTool {
  definition: ToolDefinition
  /** Default permission for this tool; overridable per session by the user. */
  defaultPermission: ToolPermission
  execute(input: JSONValue, ctx: ToolExecutionContext): Promise<ToolResult>
}

export interface ToolExecutionContext {
  conversationId?: string
  signal?: AbortSignal
  /** Requests a permission decision from the user layer. */
  requestPermission(req: ToolPermissionRequest): Promise<ToolPermissionDecision>
}
