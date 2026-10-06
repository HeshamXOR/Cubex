import { mcpSecretRef, type McpTestRequest, type McpTestResult } from '@shared/policy'
import { McpClient } from './McpClient'
import { cleanServerOutput, describeMcpFailure } from './mcpDiagnose'
import { makeScrubber, resolveMcpEnv, type SecretReader } from './mcpEnv'
import { summarizeTools } from './toolSummary'

/** The handshake allows 15 s and the tool list 20 s in real use; a test that waits for both can take this long at worst. */
const DEFAULT_DEADLINE_MS = 30_000

interface McpTestOptions {
  /** How long the whole attempt may take before the server is stopped. */
  deadlineMs?: number
  /** How long the handshake may take; defaults to what real turns allow. */
  startupTimeoutMs?: number
}

/** What a test starts: the server as the form or a saved row describes it, with its variables already resolved. */
interface McpTestTarget {
  name: string
  command: string
  args?: string[]
  /** Plain variables and secrets together, as the server will receive them. */
  env?: Record<string, string>
  /** The values in `env` that are credentials, so nothing the server prints can show them. */
  secretValues?: string[]
  /** Saved secrets that cannot be read now. The server is not started. */
  missingSecrets?: string[]
}

/** What to start for a validated request: plain variables as sent, secrets typed in the form as they were typed, and saved secrets read from `readSecret`. */
export function testTargetOf(request: McpTestRequest, readSecret: SecretReader): McpTestTarget {
  const { id } = request
  const savedNames = request.savedSecrets ?? []
  const saved = id !== undefined && savedNames.length > 0
    ? resolveMcpEnv({ id, secretEnv: Object.fromEntries(savedNames.map((name) => [name, mcpSecretRef(id, name)])) }, readSecret)
    : { env: {}, secretValues: [], missing: [] }
  const typed = request.secrets ?? {}
  const env = { ...(request.env ?? {}), ...saved.env, ...typed }
  const secretValues = [...saved.secretValues, ...Object.values(typed)]
  return {
    name: request.name,
    command: request.command,
    args: request.args ?? [],
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(secretValues.length > 0 ? { secretValues } : {}),
    ...(saved.missing.length > 0 ? { missingSecrets: saved.missing } : {})
  }
}

/**
 * Start a server the way a turn would, ask it for its tools, and stop it again. It uses a client of
 * its own, so a server that is running for a session is never touched. Never rejects: whatever goes
 * wrong comes back as `ok: false` with a reason and, when the cause is recognizable, a fix. Secrets
 * are scrubbed from every text that comes back.
 */
export async function testMcpServer(target: McpTestTarget, options: McpTestOptions = {}): Promise<McpTestResult> {
  const started = Date.now()
  if (target.missingSecrets && target.missingSecrets.length > 0) {
    const { error, hint } = describeMcpFailure({ message: '', command: target.command, missingSecrets: target.missingSecrets })
    return { ok: false, durationMs: Date.now() - started, tools: [], toolCount: 0, error, ...(hint ? { hint } : {}) }
  }
  const scrub = makeScrubber(target.secretValues ?? [])
  const client = new McpClient({
    id: 'connection-test',
    name: target.name,
    command: target.command,
    args: target.args ?? [],
    ...(target.env ? { env: target.env } : {}),
    ...(target.secretValues ? { secretValues: target.secretValues } : {}),
    startupTimeoutMs: options.startupTimeoutMs,
    shutdownGraceMs: 500
  })
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    const limit = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => {
        reject(new Error('MCP test timed out'))
        client.kill()
      }, options.deadlineMs ?? DEFAULT_DEADLINE_MS)
    })
    await Promise.race([client.connect(), limit])
    const output = cleanServerOutput(scrub(client.stderrTail))
    return {
      ok: true,
      durationMs: Date.now() - started,
      ...(client.serverInfo ? { server: client.serverInfo } : {}),
      ...(client.protocolVersion ? { protocolVersion: client.protocolVersion } : {}),
      tools: summarizeTools(client.tools),
      toolCount: client.tools.length,
      ...(output ? { output } : {})
    }
  } catch (error) {
    const { error: reason, hint } = describeMcpFailure({
      message: scrub(error instanceof Error ? error.message : String(error)),
      command: target.command,
      stderr: scrub(client.stderrTail),
      variables: Object.keys(target.env ?? {})
    })
    const output = cleanServerOutput(scrub(client.stderrTail))
    return {
      ok: false,
      durationMs: Date.now() - started,
      tools: [],
      toolCount: 0,
      error: scrub(reason),
      ...(hint ? { hint: scrub(hint) } : {}),
      ...(output ? { output } : {})
    }
  } finally {
    clearTimeout(deadline)
    await client.close()
  }
}
