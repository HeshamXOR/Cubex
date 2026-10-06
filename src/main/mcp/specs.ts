import type { McpServerConfig } from '@shared/settings'
import { getSecret } from '../credentials'
import type { McpServerSpec } from './McpClient'
import { resolveMcpEnv, type SecretReader } from './mcpEnv'

/**
 * The servers a turn connects: those switched on that have a command, with their variables resolved.
 * A secret whose saved value cannot be read is listed in `missingSecrets` instead of failing here, so
 * the turn goes on without that server and Settings says why.
 */
export function enabledMcpSpecs(servers: readonly McpServerConfig[] | undefined, readSecret: SecretReader = getSecret): McpServerSpec[] {
  return (servers ?? [])
    .filter((server) => server.enabled && server.command)
    .map((server): McpServerSpec => {
      const { env, secretValues, missing } = resolveMcpEnv(server, readSecret)
      return {
        id: server.id,
        name: server.name,
        command: server.command,
        ...(server.args ? { args: server.args } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(secretValues.length > 0 ? { secretValues } : {}),
        ...(missing.length > 0 ? { missingSecrets: missing } : {})
      }
    })
}
