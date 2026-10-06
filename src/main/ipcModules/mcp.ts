import { IPC } from '@shared/ipc'
import {
  mcpSecretRef, validateMcpSecretForget, validateMcpSecretSave, validateMcpTestRequest,
  type McpSecretSaveResult, type McpServerStatus, type McpTestResult
} from '@shared/policy'
import { getSettings } from '../config'
import { deleteSecret, encryptionAvailable, getSecret, setSecret } from '../credentials'
import { resolveMcpEnv } from '../mcp/mcpEnv'
import { testMcpServer, testTargetOf } from '../mcp/mcpTest'
import { enabledMcpSpecs } from '../mcp/specs'
import type { IpcContext } from './context'

/** Each test starts a real process; a stuck page must not be able to start dozens. */
const MAX_TESTS_AT_ONCE = 3

const NO_CREDENTIAL_STORE = 'Cubex keeps secrets in the operating system\'s credential store, and none is available here. On Linux, start a keyring such as GNOME Keyring or KWallet, then try again.'
const NOT_SAVED = 'The secret could not be saved. Check that Cubex can write to its data folder, then try again.'

export function register(ctx: IpcContext): void {
  let running = 0
  const lastTests = new Map<string, NonNullable<McpServerStatus['lastTest']>>()

  // The page sends what it would save: name, command, arguments and variables. Secret values typed in the
  // form are used for this test only; saved ones are read from the credential store by the server's id.
  // Nothing is echoed back, and the working folder cannot be chosen.
  ctx.handle(IPC.mcpTest, async (request: unknown): Promise<McpTestResult> => {
    const parsed = validateMcpTestRequest(request)
    if (!parsed.ok) throw new Error(parsed.error)
    if (running >= MAX_TESTS_AT_ONCE) {
      return { ok: false, durationMs: 0, tools: [], toolCount: 0, error: 'Other connection tests are still running.', hint: 'Wait for one to finish, then test again.' }
    }
    running++
    try {
      const result = await testMcpServer(testTargetOf(parsed.value, getSecret))
      if (parsed.value.id) {
        lastTests.set(parsed.value.id, { at: Date.now(), ok: result.ok, toolCount: result.toolCount, ...(result.error ? { error: result.error } : {}) })
      }
      return result
    } finally {
      running--
    }
  })

  // Reading the state also lets go of servers that were turned off or removed since the last turn,
  // so a disabled server stops running as soon as the page shows it as off.
  ctx.handle(IPC.mcpStatus, (): McpServerStatus[] => {
    const servers = getSettings().mcpServers ?? []
    const connections = ctx.chat.mcpConnections
    const enabled = enabledMcpSpecs(servers)
    connections.retainOnly(enabled)
    for (const id of lastTests.keys()) if (!servers.some((server) => server.id === id)) lastTests.delete(id)
    return servers.map((server): McpServerStatus => {
      const lastTest = lastTests.get(server.id)
      const spec = enabled.find((candidate) => candidate.id === server.id)
      const live = spec ? connections.statusOf(spec) : { state: 'disabled' as const, tools: [], toolCount: 0 }
      // A server that is off still says which of its secrets are gone, so its editor can ask for them again.
      const missing = spec ? spec.missingSecrets : resolveMcpEnv(server, getSecret).missing
      return { id: server.id, ...live, ...(missing && missing.length > 0 ? { missingSecrets: missing } : {}), ...(lastTest ? { lastTest } : {}) }
    })
  })

  // The reference is made here from the server's id and the variable's name, never taken from the page, so
  // a page cannot write into, or later read from, a credential that belongs to something else.
  ctx.handle(IPC.mcpSaveSecret, (request: unknown): McpSecretSaveResult => {
    const parsed = validateMcpSecretSave(request)
    if (!parsed.ok) throw new Error(parsed.error)
    const { serverId, name, value } = parsed.value
    if (!encryptionAvailable()) return { ok: false, message: NO_CREDENTIAL_STORE }
    const ref = mcpSecretRef(serverId, name)
    try {
      if (!setSecret(ref, value).ok) return { ok: false, message: NOT_SAVED }
    } catch {
      return { ok: false, message: NOT_SAVED }
    }
    return { ok: true, ref }
  })

  ctx.handle(IPC.mcpForgetSecrets, (request: unknown): void => {
    const parsed = validateMcpSecretForget(request)
    if (!parsed.ok) throw new Error(parsed.error)
    for (const name of parsed.value.names) deleteSecret(mcpSecretRef(parsed.value.serverId, name))
  })
}
