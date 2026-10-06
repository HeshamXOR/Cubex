import type { PermissionRule } from '../../../shared/ipc'

/**
 * What a saved "Always allow" rule lets through, in plain words. The sentence comes from the rule's
 * tool and pattern, not from the label the approval card showed, so it says what the rule really
 * grants. It mirrors how the main process matches (permissionRules.ts): a command rule covers the
 * command plus arguments that stay inside the project; one edit rule covers both edit and create;
 * a fetch rule covers one exact host; an MCP rule covers every call of one tool.
 */

export type RuleKind = 'command' | 'edit' | 'fetch' | 'mcp' | 'subagent' | 'unknown'

export interface RuleText {
  kind: RuleKind
  /** The sentence in pieces, so commands, hosts and tool names can be set in code type. */
  parts: Array<{ text: string; code?: boolean }>
  /** What else the rule covers, and what it still asks about. */
  detail?: string
  /** The sentence as plain text, for labels and tests. */
  text: string
}

const MCP_TOOL = /^mcp__([A-Za-z0-9_-]+?)__([A-Za-z0-9_-]+)$/
/** A command pattern is a program and the words naming its operation, never a wildcard or shell syntax. */
const COMMAND_PATTERN = /^[A-Za-z0-9._-]+(?: [A-Za-z0-9:._-]+){0,3}$/
const HOST_PATTERN = /^[a-z0-9.-]+$/

function make(kind: RuleKind, parts: RuleText['parts'], detail?: string): RuleText {
  return { kind, parts, ...(detail ? { detail } : {}), text: parts.map((part) => part.text).join('') }
}

export function describePermissionRule(rule: Pick<PermissionRule, 'tool' | 'pattern'>): RuleText {
  const { tool, pattern } = rule
  if (tool === 'run_command' && COMMAND_PATTERN.test(pattern)) {
    return make('command', [{ text: 'Run ' }, { text: pattern, code: true }])
  }
  if ((tool === 'edit_file' || tool === 'write_file') && pattern === '*') {
    // The one grant broad enough to say so on its own line.
    return make('edit', [{ text: 'Edit and create files in the project' }],
      'Deleting files still asks, and so do edits in protected places such as .git.')
  }
  if (tool === 'web_fetch' && HOST_PATTERN.test(pattern)) {
    return make('fetch', [{ text: 'Fetch pages from ' }, { text: pattern, code: true }])
  }
  if (tool === 'delegate_to_subagent' && pattern === '*') {
    return make('subagent', [{ text: 'Start subagents' }])
  }
  const mcp = MCP_TOOL.exec(tool)
  if (mcp && pattern === '*') {
    return make('mcp', [{ text: 'Use ' }, { text: mcp[2]!, code: true }, { text: ' from ' }, { text: mcp[1]!, code: true }])
  }
  const how = pattern === '*' ? [{ text: ' for any input' }] : pattern ? [{ text: ' matching ' }, { text: pattern, code: true }] : []
  return make('unknown', [{ text: 'Allow ' }, { text: tool, code: true }, ...how], 'Cubex does not recognize this rule, so it allows nothing. Remove it.')
}

/** What each kind of rule covers and still asks about, said once for the whole list instead of under every line. */
export const RULE_COVERAGE: ReadonlyArray<{ kind: Exclude<RuleKind, 'unknown'>; label: string; text: string }> = [
  { kind: 'command', label: 'Commands', text: 'The command and extra arguments that stay inside the project. Pipes, redirects and other shell syntax still ask.' },
  { kind: 'edit', label: 'File edits', text: 'Every file in the project. Deleting files still asks, and so do protected places such as .git.' },
  { kind: 'fetch', label: 'Web pages', text: 'One exact host. Its subdomains and other hosts still ask.' },
  { kind: 'mcp', label: 'Server tools', text: 'Any input to that one tool. Other tools on the same server still ask.' },
  { kind: 'subagent', label: 'Subagents', text: 'Starting any subagent, without asking first.' }
]

/** One line of the list: rules that mean the same thing are shown once and removed together. */
export interface RuleRow {
  key: string
  ids: string[]
  text: RuleText
  /** When the newest of the merged rules was saved. */
  createdAt: number
}

/** Merge rules that say the same thing (an edit rule saved from edit_file and another from write_file), newest first. */
export function mergeRules(rules: readonly PermissionRule[]): RuleRow[] {
  const rows = new Map<string, RuleRow>()
  for (const rule of rules) {
    const text = describePermissionRule(rule)
    const key = text.kind === 'unknown' ? `unknown:${rule.id}` : `${text.kind}:${text.text}`
    const row = rows.get(key)
    if (row) {
      row.ids.push(rule.id)
      row.createdAt = Math.max(row.createdAt, rule.createdAt)
    } else {
      rows.set(key, { key, ids: [rule.id], text, createdAt: rule.createdAt })
    }
  }
  return [...rows.values()].sort((a, b) => b.createdAt - a.createdAt)
}

export interface ProjectRules {
  /** Stable across cases and slash styles, so the same folder is one group. */
  key: string
  workspace: string
  /** The selected project; listed first. */
  current: boolean
  rows: RuleRow[]
}

const folderKey = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/**
 * Group rules by the project they apply to. `currentIds` are the ids main reports for the selected project,
 * so how paths compare (case, separators) stays decided in one place.
 */
export function groupRulesByProject(rules: readonly PermissionRule[], currentIds: ReadonlySet<string>): ProjectRules[] {
  const groups = new Map<string, { workspace: string; rules: PermissionRule[]; current: boolean; newest: number }>()
  for (const rule of rules) {
    const key = folderKey(rule.workspace)
    const group = groups.get(key) ?? { workspace: rule.workspace, rules: [], current: false, newest: 0 }
    group.rules.push(rule)
    group.current ||= currentIds.has(rule.id)
    group.newest = Math.max(group.newest, rule.createdAt)
    groups.set(key, group)
  }
  return [...groups.entries()]
    .sort(([, a], [, b]) => Number(b.current) - Number(a.current) || b.newest - a.newest)
    .map(([key, group]) => ({ key, workspace: group.workspace, current: group.current, rows: mergeRules(group.rules) }))
}
