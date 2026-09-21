/**
 * Slash commands available in the composer — a staple harness affordance.
 * Each command is handled locally by the store (see runSlashCommand); they never
 * hit a provider. Typing "/" at the start of an empty composer opens the palette.
 */
export interface SlashCommand {
  name: string
  args?: string
  description: string
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'new', description: 'Start a new conversation' },
  { name: 'clear', description: 'Clear the current conversation' },
  { name: 'compact', description: 'Summarize older messages to save context' },
  { name: 'model', args: '[provider]', description: 'Open the model picker' },
  { name: 'system', args: '<prompt>', description: 'Set a system prompt for this chat' },
  { name: 'retry', description: 'Regenerate the last response' },
  { name: 'cost', description: 'Show usage & cost' },
  { name: 'hardware', description: 'Open the Hardware Analyzer' },
  { name: 'settings', description: 'Open settings' }
]

export function matchCommands(input: string): SlashCommand[] {
  if (!input.startsWith('/')) return []
  const q = input.slice(1).toLowerCase().split(/\s/)[0] ?? ''
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(q))
}

export function parseCommand(input: string): { name: string; rest: string } | null {
  if (!input.startsWith('/')) return null
  const m = /^\/(\w+)\s*(.*)$/.exec(input.trim())
  if (!m) return null
  return { name: m[1]!.toLowerCase(), rest: m[2] ?? '' }
}
