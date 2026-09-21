import { nanoid } from 'nanoid'
import type { AIMessage } from '../types/message'
import type { AIRequest } from '../types/request'
import type { AIResponse } from '../types/response'
import type { RoutingPolicy } from '../types/routing'
import type {
  ExecutableTool,
  ToolCall,
  ToolExecutionContext,
  ToolResult
} from '../types/tools'
import type { ToolResultPart, ToolUsePart } from '../types/content'
import type { AIGateway, GatewayCallOptions } from './AIGateway'

export interface ToolRunResult {
  finalResponse: AIResponse
  /** All responses across the tool loop, in order. */
  turns: AIResponse[]
  toolInvocations: Array<{ call: ToolCall; result: ToolResult }>
}

/**
 * Runs the model → tool → model loop with a permission gate. No tool executes
 * without an explicit `allow` decision from the provided context.
 */
export class ToolRunner {
  constructor(
    private readonly gateway: AIGateway,
    private readonly tools: Map<string, ExecutableTool>
  ) {}

  async run(
    request: AIRequest,
    policy: RoutingPolicy,
    ctx: ToolExecutionContext,
    opts: GatewayCallOptions = {},
    maxIterations = 8
  ): Promise<ToolRunResult> {
    const messages: AIMessage[] = [...request.messages]
    const turns: AIResponse[] = []
    const toolInvocations: ToolRunResult['toolInvocations'] = []

    for (let iter = 0; iter < maxIterations; iter++) {
      const response = await this.gateway.send({ ...request, messages }, policy, opts)
      turns.push(response)

      if (response.stopReason !== 'tool_use' || response.toolCalls.length === 0) {
        return { finalResponse: response, turns, toolInvocations }
      }

      // Record the assistant's tool_use turn.
      const assistantParts: ToolUsePart[] = response.toolCalls.map((tc) => ({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: tc.input
      }))
      messages.push({ role: 'assistant', content: assistantParts })

      // Execute each tool call under the permission gate.
      const resultParts: ToolResultPart[] = []
      for (const call of response.toolCalls) {
        const result = await this.executeCall(call, ctx)
        toolInvocations.push({ call, result })
        resultParts.push({
          type: 'tool_result',
          toolUseId: call.id,
          content: [{ type: 'text', text: this.stringifyResult(result) }],
          ...(result.isError ? { isError: true } : {})
        })
      }
      messages.push({ role: 'tool', content: resultParts })
    }

    // Exhausted iterations — return the last turn.
    const last = turns[turns.length - 1]!
    return { finalResponse: last, turns, toolInvocations }
  }

  private async executeCall(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResult> {
    const tool = this.tools.get(call.name)
    if (!tool) {
      return { toolUseId: call.id, content: `Tool "${call.name}" is not registered.`, isError: true }
    }

    // Permission gate.
    let allowed = tool.defaultPermission === 'allow'
    if (tool.defaultPermission === 'ask') {
      const decision = await ctx.requestPermission({ tool: tool.definition, call })
      allowed = decision.decision === 'allow'
      if (!allowed) {
        return {
          toolUseId: call.id,
          content: `Permission denied for tool "${call.name}".`,
          isError: true
        }
      }
    } else if (tool.defaultPermission === 'deny') {
      return { toolUseId: call.id, content: `Tool "${call.name}" is denied by policy.`, isError: true }
    }

    try {
      return await tool.execute(call.input, ctx)
    } catch (err) {
      return {
        toolUseId: call.id,
        content: `Tool execution error: ${err instanceof Error ? err.message : String(err)}`,
        isError: true
      }
    }
  }

  private stringifyResult(result: ToolResult): string {
    if (typeof result.content === 'string') return result.content
    try {
      return JSON.stringify(result.content)
    } catch {
      return String(result.content)
    }
  }
}

/** Convenience: build a tool registry from executable tools. */
export function toolRegistry(tools: ExecutableTool[]): Map<string, ExecutableTool> {
  const map = new Map<string, ExecutableTool>()
  for (const t of tools) map.set(t.definition.name, t)
  return map
}

/** Generate a fresh tool-call id (adapters may use provider ids instead). */
export const newToolCallId = (): string => `tc_${nanoid(10)}`
