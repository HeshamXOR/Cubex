import { MCP_DESCRIPTION_LIMIT, MCP_LIST_LIMIT, type McpToolSummary } from '@shared/policy'

/** Name and description only, bounded: the Settings page lists tools, it never needs their schemas. */
export function summarizeTools(tools: ReadonlyArray<{ name: string; description?: string }>): McpToolSummary[] {
  return tools.slice(0, MCP_LIST_LIMIT).map((tool) => ({
    name: String(tool.name).slice(0, 200),
    ...(typeof tool.description === 'string' && tool.description.trim()
      ? { description: tool.description.trim().slice(0, MCP_DESCRIPTION_LIMIT) }
      : {})
  }))
}
