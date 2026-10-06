import type { ExecutableTool, JSONValue } from '@core/types'
import { COMMAND_OUTPUT_MAX_PAGE_BYTES, type CommandOutputStore } from '../commandOutput'

/** Read saved output from this task without granting arbitrary filesystem access. */
export function createReadCommandOutputTool(store: Pick<CommandOutputStore, 'read'>, conversationId: string): ExecutableTool {
  return {
    definition: {
      name: 'read_command_output',
      description: 'Read a saved run_command output by its output_id from the current task. Output is UTF-8 text; offset/limit are bytes. ' +
        'Use nextOffset from the preceding page to continue. The store keeps up to 2 MiB per command and the newest 50 command outputs per task. ' +
        'truncated means the complete output was not saved; interrupted means a partial capture survived restart. Never pass a filesystem path.',
      inputSchema: {
        type: 'object', properties: {
          output_id: { type: 'string', description: 'Saved output UUID returned by run_command.' },
          offset: { type: 'integer', minimum: 0, description: 'UTF-8 byte offset; default 0. Follow the previous page’s nextOffset.' },
          limit: { type: 'integer', minimum: 4, maximum: COMMAND_OUTPUT_MAX_PAGE_BYTES, description: 'Maximum bytes to return; default 16384.' }
        }, required: ['output_id'], additionalProperties: false
      }
    },
    defaultPermission: 'allow',
    async execute(input: JSONValue, ctx) {
      if (ctx.signal?.aborted) return { toolUseId: '', isError: true, content: 'Reading command output was cancelled.' }
      if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.output_id !== 'string' ||
        Object.keys(input).some((key) => !['output_id', 'offset', 'limit'].includes(key)) ||
        (input.offset !== undefined && typeof input.offset !== 'number') || (input.limit !== undefined && typeof input.limit !== 'number')) {
        return { toolUseId: '', isError: true, content: 'read_command_output requires output_id and optional numeric offset/limit; paths are not accepted.' }
      }
      try {
        const page = store.read(conversationId, input.output_id, {
          ...(input.offset !== undefined ? { offset: input.offset } : {}), ...(input.limit !== undefined ? { limit: input.limit } : {})
        })
        return page ? { toolUseId: '', content: JSON.stringify(page) }
          : { toolUseId: '', isError: true, content: 'No matching saved command output exists in this task. Older outputs may have been removed by the 50-artifact retention limit.' }
      } catch (error) {
        return { toolUseId: '', isError: true, content: `Could not read saved command output: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
  }
}
