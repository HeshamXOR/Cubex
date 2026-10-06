import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface AgentProfile {
  name: string
  description: string
  /** The profile's system prompt (the markdown body). */
  systemPrompt: string
}

const MAX_PROMPT = 40_000

/** Parse an agent profile markdown file: `---` frontmatter then the body prompt. */
function parseProfile(text: string, fallbackName: string): AgentProfile | undefined {
  let name = fallbackName
  let description = ''
  let body = text
  const fm = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(text)
  if (fm) {
    body = text.slice(fm[0].length)
    for (const line of fm[1]!.split('\n')) {
      const m = /^(name|description)\s*:\s*(.+)$/.exec(line.trim())
      if (m) {
        const val = m[2]!.trim().replace(/^["']|["']$/g, '')
        if (m[1] === 'name') name = val
        else description = val
      }
    }
  }
  const systemPrompt = body.trim().slice(0, MAX_PROMPT)
  if (!name || !systemPrompt) return undefined
  return { name, description, systemPrompt }
}

/**
 * Discover custom subagent profiles under the workspace — `.cubex/agents/*.md`
 * and `.claude/agents/*.md` (Claude Code-compatible). Each is a named role with
 * its own system prompt the primary model can delegate to.
 */
export function loadAgentProfiles(workspace: string): AgentProfile[] {
  const dirs = [join(workspace, '.cubex', 'agents'), join(workspace, '.claude', 'agents')]
  const out: AgentProfile[] = []
  const seen = new Set<string>()
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    let files: string[]
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.md'))
    } catch {
      continue
    }
    for (const file of files) {
      try {
        const parsed = parseProfile(readFileSync(join(dir, file), 'utf8'), file.replace(/\.md$/, ''))
        if (parsed && !seen.has(parsed.name)) {
          seen.add(parsed.name)
          out.push(parsed)
        }
      } catch {
        /* skip unreadable profile */
      }
    }
  }
  return out
}
