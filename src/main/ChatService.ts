import { nanoid } from 'nanoid'
import { AIGateway, createSubagentTool } from '@core/gateway'
import { StreamAccumulator } from '@core/streaming'
import type {
  AIMessage,
  AIRequest,
  AIStreamEvent,
  ExecutableTool,
  GatewayEvent,
  RoutingPolicy,
  ToolCall,
  ToolDefinition,
  ToolPermissionDecision
} from '@core/types'
import { userMessage, assistantMessage } from '@core/builders'
import type { ChatEvent, ChatStartRequest, PermissionAsk } from '@shared/ipc'
import { conversationRepo } from './db'
import { getSettings } from './config'
import { createFileTools, parseDiffMarker } from './tools/fileTools'
import type { ProviderManager } from './ProviderManager'
import { recordUsage } from './cost'
import { logger } from './logger'

const MAX_TOOL_ITERATIONS = 12

/**
 * Bridges the renderer's chat requests to the core AIGateway. Runs a streaming
 * tool loop (model → tools → model), forwards normalized stream/gateway/tool
 * events over IPC, gates mutating tools behind a user permission round-trip, and
 * records usage/cost. Each active generation has an AbortController.
 */
export class ChatService {
  private readonly gateway: AIGateway
  private readonly active = new Map<string, AbortController>()
  private readonly pendingPermissions = new Map<string, (d: ToolPermissionDecision) => void>()

  constructor(
    private readonly providers: ProviderManager,
    private readonly emit: (event: ChatEvent) => void
  ) {
    this.gateway = new AIGateway(this.providers.resolve)
  }

  async start(req: ChatStartRequest): Promise<{ streamId: string }> {
    const streamId = nanoid()
    const controller = new AbortController()
    this.active.set(streamId, controller)

    const history = this.loadHistory(req.conversationId)
    const userParts = [...(req.attachments ?? [])]
    const userMsg: AIMessage = userParts.length
      ? { role: 'user', content: [{ type: 'text', text: req.userText }, ...userParts] }
      : userMessage(req.userText)
    const messages: AIMessage[] = [...history, userMsg]

    // Assemble the tool set for this turn.
    const tools = new Map<string, ExecutableTool>()
    if (req.subagentEnabled) {
      const sub = createSubagentTool(this.gateway, req.policy)
      tools.set(sub.definition.name, sub)
    }
    const workspace = getSettings().general.workspacePath
    if (req.fileToolsEnabled && workspace) {
      for (const t of createFileTools(workspace)) tools.set(t.definition.name, t)
    }

    const request: AIRequest = {
      model: req.policy.primary.model,
      messages,
      ...(req.systemPrompt ? { system: req.systemPrompt } : {}),
      ...(tools.size ? { tools: [...tools.values()].map((t) => t.definition) } : {}),
      stream: true
    }
    const headers = req.longContext ? { 'x-cubex-long-context': '1' } : undefined

    void this.runLoop(streamId, request, req.policy, tools, controller, headers)
    return { streamId }
  }

  private loadHistory(conversationId: string): AIMessage[] {
    const conv = conversationRepo.get(conversationId)
    if (!conv) return []
    const out: AIMessage[] = []
    for (const m of conv.messages) {
      if (!m.text) continue
      if (m.role === 'user') out.push(userMessage(m.text))
      else if (m.role === 'assistant') out.push(assistantMessage(m.text))
    }
    return out
  }

  /** Model → tool → model loop with streaming, over the gateway. */
  private async runLoop(
    streamId: string,
    baseRequest: AIRequest,
    policy: RoutingPolicy,
    tools: Map<string, ExecutableTool>,
    controller: AbortController,
    headers?: Record<string, string>
  ): Promise<void> {
    const onGateway = (event: GatewayEvent): void => this.emit({ streamId, kind: 'gateway', event })
    const started = Date.now()
    const toolDefs: ToolDefinition[] | undefined = tools.size
      ? [...tools.values()].map((t) => t.definition)
      : undefined
    const messages = [...baseRequest.messages]
    let finalProvider = policy.primary.providerId
    let finalModel = policy.primary.model

    try {
      for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
        if (controller.signal.aborted) break
        const req: AIRequest = { ...baseRequest, messages, ...(toolDefs ? { tools: toolDefs } : {}) }
        const acc = new StreamAccumulator(finalProvider, finalModel)
        let sawCompleted = false

        for await (const event of this.gateway.stream(req, policy, {
          signal: controller.signal,
          onEvent: onGateway,
          ...(headers ? { headers } : {})
        })) {
          this.captureUsage(event, finalProvider, finalModel)
          if (event.type === 'completed') {
            sawCompleted = true
            finalProvider = event.response.provider
            finalModel = event.response.model
            acc.push(event)
            // Only surface a `completed` to the UI on the final (non-tool) turn.
            if (event.response.toolCalls.length > 0) continue
          }
          this.emit({ streamId, kind: 'stream', event })
        }

        const response = acc.finalize()
        const calls = response.toolCalls
        if (!sawCompleted || calls.length === 0 || toolDefs === undefined) break

        // Record the assistant tool_use turn, then run each tool.
        messages.push({
          role: 'assistant',
          content: calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input }))
        })
        const resultParts: AIMessage['content'] = []
        for (const call of calls) {
          const result = await this.runTool(streamId, tools, call, controller)
          const text = typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
          resultParts.push({
            type: 'tool_result',
            toolUseId: call.id,
            content: [{ type: 'text', text }],
            ...(result.isError ? { isError: true } : {})
          })
        }
        messages.push({ role: 'tool', content: resultParts })
      }

      logger.info('Chat turn completed', {
        provider: finalProvider,
        model: finalModel,
        durationMs: Date.now() - started,
        status: 'ok'
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error(`Chat stream error: ${message}`, { provider: finalProvider, model: finalModel })
      this.emit({
        streamId,
        kind: 'stream',
        event: {
          type: 'error',
          error:
            err instanceof Error && 'category' in err
              ? (err as never)
              : ({ provider: finalProvider, category: 'UNKNOWN', message, classification: 'unknown', retryable: false } as never)
        } as AIStreamEvent
      })
    } finally {
      this.active.delete(streamId)
    }
  }

  /** Execute one tool call with permission gating + activity events. */
  private async runTool(
    streamId: string,
    tools: Map<string, ExecutableTool>,
    call: ToolCall,
    controller: AbortController
  ): Promise<{ content: unknown; isError?: boolean }> {
    const tool = tools.get(call.name)
    const title = describeToolCall(call)
    this.emit({ streamId, kind: 'tool', tool: { id: call.id, name: call.name, phase: 'running', title } })

    if (!tool) {
      this.emit({ streamId, kind: 'tool', tool: { id: call.id, name: call.name, phase: 'error', title, detail: 'Unknown tool' } })
      return { content: `Tool "${call.name}" is not available.`, isError: true }
    }

    // Permission gate.
    if (tool.defaultPermission === 'deny') {
      this.emit({ streamId, kind: 'tool', tool: { id: call.id, name: call.name, phase: 'error', title, detail: 'Denied by policy' } })
      return { content: `Tool "${call.name}" is denied.`, isError: true }
    }
    if (tool.defaultPermission === 'ask') {
      const decision = await this.requestPermission(streamId, call, title, controller)
      if (decision.decision !== 'allow') {
        this.emit({ streamId, kind: 'tool', tool: { id: call.id, name: call.name, phase: 'error', title, detail: 'Denied by user' } })
        return { content: `Permission denied for "${call.name}".`, isError: true }
      }
    }

    try {
      const result = await tool.execute(call.input, {
        ...(controller.signal ? { signal: controller.signal } : {}),
        requestPermission: async () => ({ decision: 'allow' })
      })
      const text = typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
      const diff = parseDiffMarker(text)
      this.emit({
        streamId,
        kind: 'tool',
        tool: {
          id: call.id,
          name: call.name,
          phase: result.isError ? 'error' : 'done',
          title,
          detail: text.replace(/«diff[^»]*»/g, '').trim().slice(0, 120),
          ...(diff ? { added: diff.added, removed: diff.removed } : {})
        }
      })
      return { content: text.replace(/«diff[^»]*»/g, '').trim(), ...(result.isError ? { isError: true } : {}) }
    } catch (e) {
      const detail = (e as Error).message
      this.emit({ streamId, kind: 'tool', tool: { id: call.id, name: call.name, phase: 'error', title, detail } })
      return { content: `Tool error: ${detail}`, isError: true }
    }
  }

  private requestPermission(
    streamId: string,
    call: ToolCall,
    title: string,
    controller: AbortController
  ): Promise<ToolPermissionDecision> {
    const id = nanoid()
    const ask: PermissionAsk = {
      id,
      toolName: call.name,
      title,
      detail: summarizeInput(call.input)
    }
    return new Promise<ToolPermissionDecision>((resolvePromise) => {
      const onAbort = (): void => {
        this.pendingPermissions.delete(id)
        resolvePromise({ decision: 'deny', reason: 'cancelled' })
      }
      if (controller.signal.aborted) return onAbort()
      controller.signal.addEventListener('abort', onAbort, { once: true })
      this.pendingPermissions.set(id, (d) => {
        controller.signal.removeEventListener('abort', onAbort)
        resolvePromise(d)
      })
      this.emit({ streamId, kind: 'permission', ask })
    })
  }

  resolvePermission(id: string, decision: 'allow' | 'deny'): void {
    const resolver = this.pendingPermissions.get(id)
    if (resolver) {
      this.pendingPermissions.delete(id)
      resolver({ decision })
    }
  }

  private captureUsage(event: AIStreamEvent, providerId: string, modelId: string): void {
    if (event.type !== 'completed' && event.type !== 'usage') return
    const usage = event.type === 'completed' ? event.response.usage : event.usage
    if (!usage) return
    const model = this.providers.getModelInfo(providerId, modelId)
    const execution = model?.location === 'local' ? 'local' : 'cloud'
    recordUsage({ providerId, model, modelId, usage, execution })
  }

  cancel(streamId: string): void {
    const controller = this.active.get(streamId)
    if (controller) {
      controller.abort()
      this.active.delete(streamId)
      logger.info('Chat stream cancelled by user', { status: 'cancelled' })
    }
  }

  cancelAll(): void {
    for (const [, c] of this.active) c.abort()
    this.active.clear()
    this.pendingPermissions.clear()
  }
}

/** A short human title for a tool call, e.g. "Edit src/app.ts". */
function describeToolCall(call: ToolCall): string {
  const input = (call.input ?? {}) as Record<string, unknown>
  const path = typeof input.path === 'string' ? input.path : undefined
  switch (call.name) {
    case 'read_file':
      return `Read ${path ?? ''}`.trim()
    case 'write_file':
      return `Edit ${path ?? ''}`.trim()
    case 'list_files':
      return `List ${path ?? '.'}`
    case 'search_files':
      return `Search "${typeof input.query === 'string' ? input.query : ''}"`
    case 'delegate_to_subagent':
      return 'Delegate to subagent'
    default:
      return call.name
  }
}

function summarizeInput(input: unknown): string {
  try {
    const s = JSON.stringify(input)
    return s.length > 160 ? s.slice(0, 160) + '…' : s
  } catch {
    return ''
  }
}
