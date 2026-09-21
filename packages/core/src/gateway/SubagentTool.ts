import type { AIRequest } from '../types/request'
import type { RoutingPolicy, RoutingTarget } from '../types/routing'
import type { JSONValue } from '../types/common'
import type { ExecutableTool, ToolResult } from '../types/tools'
import { userMessage } from '../builders'
import type { AIGateway } from './AIGateway'

/**
 * A subagent is a built-in tool that lets the primary model delegate a scoped
 * task to a fresh, isolated conversation — its own system prompt, its own
 * (optionally cheaper) model, and no access to the parent's history. The result
 * text is returned to the parent as a tool result.
 *
 * This mirrors the "sub-agent / delegation" pattern in modern harnesses while
 * staying provider-agnostic: the subagent runs through the same AIGateway, so it
 * works with any configured provider and honors retry/fallback.
 */
export interface SubagentConfig {
  /** Tool name the model calls (default "delegate_to_subagent"). */
  name?: string
  description?: string
  /** System prompt framing the subagent's role. */
  systemPrompt?: string
  /** Which provider/model the subagent uses (defaults to the parent target). */
  target?: RoutingTarget
  /** Retry/timeout for the subagent (defaults to the parent policy's). */
  policyOverrides?: Partial<RoutingPolicy>
  /** Cap the subagent's own tool-less turns; subagents don't recurse by default. */
  maxOutputTokens?: number
}

const DEFAULT_SYSTEM =
  'You are a focused subagent. Complete the delegated task precisely and return only the result — no preamble, no meta-commentary. You have no access to the parent conversation beyond the task text provided.'

/**
 * Build an ExecutableTool that delegates to a subagent. `defaultPermission` is
 * 'allow' by default because a subagent only performs model inference (no side
 * effects) — callers can tighten this to 'ask'.
 */
export function createSubagentTool(
  gateway: AIGateway,
  parentPolicy: RoutingPolicy,
  config: SubagentConfig = {}
): ExecutableTool {
  const name = config.name ?? 'delegate_to_subagent'
  return {
    definition: {
      name,
      description:
        config.description ??
        'Delegate a self-contained subtask to an isolated subagent and get back its result. Use for focused research, drafting, or analysis that would clutter the main thread. Provide a complete, standalone task description.',
      inputSchema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'A complete, self-contained description of the subtask. The subagent cannot see this conversation.'
          },
          context: {
            type: 'string',
            description: 'Optional extra context or data the subagent needs to do the task.'
          }
        },
        required: ['task']
      }
    },
    defaultPermission: 'allow',
    async execute(input: JSONValue): Promise<ToolResult> {
      const { task, context } = (input ?? {}) as { task?: string; context?: string }
      if (!task || typeof task !== 'string') {
        return { toolUseId: '', content: 'Subagent error: "task" is required.', isError: true }
      }

      const target = config.target ?? parentPolicy.primary
      const policy: RoutingPolicy = {
        primary: target,
        fallbacks: config.policyOverrides?.fallbacks ?? [],
        fallbackEnabled: config.policyOverrides?.fallbackEnabled ?? false,
        retry: config.policyOverrides?.retry ?? parentPolicy.retry,
        timeout: config.policyOverrides?.timeout ?? parentPolicy.timeout
      }

      const prompt = context ? `${task}\n\n---\nContext:\n${context}` : task
      const request: AIRequest = {
        model: target.model,
        system: config.systemPrompt ?? DEFAULT_SYSTEM,
        messages: [userMessage(prompt)],
        params: { maxOutputTokens: config.maxOutputTokens ?? 2048 }
      }

      try {
        const response = await gateway.send(request, policy)
        return { toolUseId: '', content: response.text || '(subagent returned no text)' }
      } catch (err) {
        return {
          toolUseId: '',
          content: `Subagent failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true
        }
      }
    }
  }
}
