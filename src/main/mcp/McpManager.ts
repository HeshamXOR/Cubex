import type { ExecutableTool, JSONValue, ToolResult } from '@core/types'
import type { McpServerStatus } from '@shared/policy'
import { McpClient, type McpServerSpec } from './McpClient'
import { cleanServerOutput, describeMcpFailure } from './mcpDiagnose'
import { envDigest } from './mcpEnv'
import { sanitizeInputSchema } from './schemaSanitize'
import { summarizeTools } from './toolSummary'
import { assignServerSegments, assignToolNames, MCP_TOOL_PREFIX } from './toolNames'

/** What a server's tool description may add to the model's context. */
const MAX_TOOL_DESCRIPTION = 2_000

interface Connection {
  client: McpClient
  /** The launch line this client was started with; a changed line means a different server. */
  launch: string
}

/** The command, arguments and a fingerprint of the variables. A changed secret restarts the server; the value is never kept in the line. */
const launchOf = (spec: McpServerSpec): string => JSON.stringify([spec.command, spec.args ?? [], envDigest(spec.env), spec.missingSecrets ?? []])

/**
 * Owns the live MCP client connections and adapts each server's tools into the
 * harness's ExecutableTool shape (namespaced `mcp__<server>__<tool>`). Clients
 * persist across turns; a dead one is reconnected on next use. External tools
 * default to `ask` — they can have side effects the harness can't reason about.
 */
export class McpManager {
  private readonly connections = new Map<string, Connection>()

  /** Connect all enabled servers (best-effort, together) and return their adapted tools. */
  async getTools(specs: McpServerSpec[]): Promise<ExecutableTool[]> {
    this.retainOnly(specs)
    // Names come from the server names, so the model, the approval card and a saved rule all read the same.
    const segments = assignServerSegments(specs)
    const perServer = await Promise.all(specs.map((spec) => this.adapt(spec, segments.get(spec.id) ?? 'server')))
    return perServer.flat()
  }

  private connectionFor(spec: McpServerSpec): Connection {
    let connection = this.connections.get(spec.id)
    if (!connection) {
      connection = { client: new McpClient(spec), launch: launchOf(spec) }
      this.connections.set(spec.id, connection)
    }
    return connection
  }

  private async adapt(spec: McpServerSpec, segment: string): Promise<ExecutableTool[]> {
    // Without the value of a secret the server cannot work, so it is not started. Settings says which one to enter again.
    if (spec.missingSecrets && spec.missingSecrets.length > 0) return []
    const { client } = this.connectionFor(spec)
    try {
      if (!client.connected) await client.connect()
    } catch {
      // Server unavailable — skip it rather than failing the whole turn. Settings shows why.
      return []
    }
    const listed = client.tools.filter((tool) => typeof tool?.name === 'string' && tool.name.length > 0)
    // Providers reject a whole request for one bad name (^[a-zA-Z0-9_-]{1,64}$), so each name is made valid and unique here.
    const names = assignToolNames(segment, listed.map((tool) => tool.name))
    const out: ExecutableTool[] = []
    for (const tool of listed) {
      const name = names.get(tool.name)
      if (!name) continue
      const description = `[${spec.name}] ${tool.description ?? tool.name}`.slice(0, MAX_TOOL_DESCRIPTION)
      out.push({
        definition: {
          name,
          description,
          inputSchema: sanitizeInputSchema(tool.inputSchema).schema as ExecutableTool['definition']['inputSchema']
        },
        defaultPermission: 'ask',
        async execute(input: JSONValue, ctx): Promise<ToolResult> {
          try {
            const { text, isError } = await client.callTool(tool.name, input, ctx?.signal ? { signal: ctx.signal } : undefined)
            return { toolUseId: '', content: text, isError }
          } catch (e) {
            return { toolUseId: '', content: `MCP call failed: ${(e as Error).message}`, isError: true }
          }
        }
      })
    }
    return out
  }

  /**
   * Stop servers that are no longer wanted: turned off, removed, or started with a different command
   * or arguments than the ones now saved. Without this a disabled server's process would run until quit.
   */
  retainOnly(specs: readonly McpServerSpec[]): void {
    const wanted = new Map(specs.map((spec) => [spec.id, launchOf(spec)]))
    for (const [id, connection] of this.connections) {
      if (wanted.get(id) === connection.launch) continue
      connection.client.retire()
      this.connections.delete(id)
    }
  }

  /** What is known about one enabled server right now. Reads state only; it never starts or stops anything. */
  statusOf(spec: McpServerSpec): Omit<McpServerStatus, 'id' | 'lastTest'> {
    if (spec.missingSecrets && spec.missingSecrets.length > 0) {
      const { error, hint } = describeMcpFailure({ message: '', command: spec.command, missingSecrets: spec.missingSecrets })
      return { state: 'failed', tools: [], toolCount: 0, error, ...(hint ? { hint } : {}), missingSecrets: [...spec.missingSecrets] }
    }
    const connection = this.connections.get(spec.id)
    const client = connection?.launch === launchOf(spec) ? connection.client : undefined
    if (!client) return { state: 'idle', tools: [], toolCount: 0 }
    if (client.connected) {
      return {
        state: 'connected',
        tools: summarizeTools(client.tools),
        toolCount: client.tools.length,
        ...(client.serverInfo ? { server: client.serverInfo } : {})
      }
    }
    if (!client.lastError) return { state: 'idle', tools: [], toolCount: 0 }
    const { error, hint } = describeMcpFailure({ message: client.lastError, command: spec.command, stderr: client.stderrTail, variables: Object.keys(spec.env ?? {}) })
    const output = cleanServerOutput(client.stderrTail)
    return { state: 'failed', tools: [], toolCount: 0, error, ...(hint ? { hint } : {}), ...(output ? { output } : {}) }
  }

  /** Human label for an adapted tool name (for the activity card). */
  static describe(toolName: string): string | undefined {
    if (!toolName.startsWith(MCP_TOOL_PREFIX)) return undefined
    const rest = toolName.slice(MCP_TOOL_PREFIX.length)
    const idx = rest.indexOf('__')
    return idx >= 0 ? `${rest.slice(0, idx)} · ${rest.slice(idx + 2)}` : rest
  }

  /** Quit path: kill every server tree now. A graceful close would not finish before the process exits. */
  disposeAll(): void {
    for (const { client } of this.connections.values()) client.retire()
    this.connections.clear()
  }
}
