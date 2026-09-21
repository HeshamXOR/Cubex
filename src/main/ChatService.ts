import { nanoid } from 'nanoid'
import { AIGateway, createSubagentTool } from '@core/gateway'
import type { AIMessage, AIRequest, AIStreamEvent, GatewayEvent, RoutingPolicy, ToolDefinition } from '@core/types'
import { userMessage, assistantMessage } from '@core/builders'
import type { ChatEvent, ChatStartRequest } from '@shared/ipc'
import { conversationRepo } from './db'
import type { ProviderManager } from './ProviderManager'
import { recordUsage } from './cost'
import { logger } from './logger'

/**
 * Bridges the renderer's chat requests to the core AIGateway, forwarding
 * normalized stream + gateway events over IPC and recording usage/cost.
 * Each active generation gets an AbortController for cancellation.
 */
export class ChatService {
  private readonly gateway: AIGateway
  private readonly active = new Map<string, AbortController>()

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

    // Rebuild multi-turn history from the stored conversation so the model sees
    // prior context, then append the new user message.
    const history = this.loadHistory(req.conversationId)
    const messages: AIMessage[] = [...history, userMessage(req.userText)]

    // The subagent tool lets the model delegate scoped subtasks (opt-in).
    const tools: ToolDefinition[] = []
    if (req.subagentEnabled) {
      tools.push(createSubagentTool(this.gateway, req.policy).definition)
    }

    const request: AIRequest = {
      model: req.policy.primary.model,
      messages,
      ...(req.systemPrompt ? { system: req.systemPrompt } : {}),
      ...(tools.length ? { tools } : {}),
      stream: true
    }

    // Opt into a provider's long-context beta when requested (adapter decides
    // whether the selected model actually needs the header).
    const headers = req.longContext ? { 'x-cubex-long-context': '1' } : undefined

    // Fire-and-forget the streaming loop; events are pushed via `emit`.
    void this.runStream(streamId, request, req.policy, controller, headers)
    return { streamId }
  }

  /** Reconstruct AIMessages from the persisted conversation (text only). */
  private loadHistory(conversationId: string): AIMessage[] {
    const conv = conversationRepo.get(conversationId)
    if (!conv) return []
    const out: AIMessage[] = []
    for (const m of conv.messages) {
      if (!m.text) continue
      if (m.role === 'user') out.push(userMessage(m.text))
      else if (m.role === 'assistant') out.push(assistantMessage(m.text))
      // system/tool rows are reconstructed from systemPrompt / live tools, skip here
    }
    return out
  }

  private async runStream(
    streamId: string,
    request: AIRequest,
    policy: RoutingPolicy,
    controller: AbortController,
    headers?: Record<string, string>
  ): Promise<void> {
    const onGateway = (event: GatewayEvent): void => this.emit({ streamId, kind: 'gateway', event })
    const started = Date.now()
    let finalProvider = policy.primary.providerId
    let finalModel = policy.primary.model

    try {
      for await (const event of this.gateway.stream(request, policy, {
        signal: controller.signal,
        onEvent: onGateway,
        ...(headers ? { headers } : {})
      })) {
        this.emit({ streamId, kind: 'stream', event })
        this.captureUsage(event, finalProvider, finalModel)
        if (event.type === 'completed') {
          finalProvider = event.response.provider
          finalModel = event.response.model
        }
      }
      logger.info('Chat stream completed', {
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
          error: err instanceof Error && 'category' in err ? (err as never) : ({
            provider: finalProvider,
            category: 'UNKNOWN',
            message,
            classification: 'unknown',
            retryable: false
          } as never)
        } as AIStreamEvent
      })
    } finally {
      this.active.delete(streamId)
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
  }
}
