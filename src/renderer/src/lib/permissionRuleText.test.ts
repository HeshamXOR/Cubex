import { describe, expect, it } from 'vitest'
import type { PermissionRule } from '../../../shared/ipc'
import { describePermissionRule, groupRulesByProject, mergeRules, RULE_COVERAGE } from './permissionRuleText'

const rule = (over: Partial<PermissionRule>): PermissionRule => ({
  id: 'r1', workspace: 'C:\\code\\lumen-web', tool: 'run_command', pattern: 'npm test', label: 'npm test', createdAt: 1_000, ...over
})

describe('describePermissionRule', () => {
  it.each([
    [{ tool: 'run_command', pattern: 'npm test' }, 'command', 'Run npm test'],
    [{ tool: 'run_command', pattern: 'npm run build' }, 'command', 'Run npm run build'],
    [{ tool: 'run_command', pattern: 'cargo test' }, 'command', 'Run cargo test'],
    [{ tool: 'run_command', pattern: 'pytest' }, 'command', 'Run pytest'],
    [{ tool: 'run_command', pattern: 'python -m pytest' }, 'command', 'Run python -m pytest'],
    [{ tool: 'run_command', pattern: 'pnpm run test:unit' }, 'command', 'Run pnpm run test:unit'],
    [{ tool: 'edit_file', pattern: '*' }, 'edit', 'Edit and create files in the project'],
    [{ tool: 'write_file', pattern: '*' }, 'edit', 'Edit and create files in the project'],
    [{ tool: 'web_fetch', pattern: 'docs.example.com' }, 'fetch', 'Fetch pages from docs.example.com'],
    [{ tool: 'delegate_to_subagent', pattern: '*' }, 'subagent', 'Start subagents'],
    [{ tool: 'mcp__github__create_issue', pattern: '*' }, 'mcp', 'Use create_issue from github'],
    [{ tool: 'mcp__files__read_multiple_files', pattern: '*' }, 'mcp', 'Use read_multiple_files from files'],
    [{ tool: 'mcp__a__b__c', pattern: '*' }, 'mcp', 'Use b__c from a']
  ])('says what %j grants', (input, kind, text) => {
    const described = describePermissionRule(input)
    expect(described.kind).toBe(kind)
    expect(described.text).toBe(text)
  })

  it('sets commands, hosts and tool names in code type, and the rest in plain type', () => {
    expect(describePermissionRule({ tool: 'run_command', pattern: 'npm test' }).parts).toEqual([{ text: 'Run ' }, { text: 'npm test', code: true }])
    expect(describePermissionRule({ tool: 'web_fetch', pattern: 'a.dev' }).parts).toEqual([{ text: 'Fetch pages from ' }, { text: 'a.dev', code: true }])
    expect(describePermissionRule({ tool: 'mcp__s__t', pattern: '*' }).parts).toEqual([{ text: 'Use ' }, { text: 't', code: true }, { text: ' from ' }, { text: 's', code: true }])
    expect(describePermissionRule({ tool: 'edit_file', pattern: '*' }).parts).toEqual([{ text: 'Edit and create files in the project' }])
  })

  it('adds a line only for the broad edit grant, which names what still asks', () => {
    expect(describePermissionRule({ tool: 'edit_file', pattern: '*' }).detail).toContain('Deleting files still asks')
    for (const tool of [{ tool: 'run_command', pattern: 'npm test' }, { tool: 'web_fetch', pattern: 'a.dev' }, { tool: 'mcp__s__t', pattern: '*' }, { tool: 'delegate_to_subagent', pattern: '*' }]) {
      expect(describePermissionRule(tool).detail).toBeUndefined()
    }
  })

  it('explains every kind of rule once for the whole list', () => {
    expect(RULE_COVERAGE.map((entry) => entry.kind).sort()).toEqual(['command', 'edit', 'fetch', 'mcp', 'subagent'])
    for (const entry of RULE_COVERAGE) expect(entry.text).toMatch(/\.$/)
  })

  it.each([
    [{ tool: 'run_command', pattern: '*' }, 'Allow run_command for any input'],
    [{ tool: 'run_command', pattern: 'rm -rf /; echo' }, 'Allow run_command matching rm -rf /; echo'],
    [{ tool: 'run_command', pattern: '' }, 'Allow run_command'],
    [{ tool: 'edit_file', pattern: 'src/*' }, 'Allow edit_file matching src/*'],
    [{ tool: 'web_fetch', pattern: '*' }, 'Allow web_fetch for any input'],
    [{ tool: 'web_fetch', pattern: 'a b' }, 'Allow web_fetch matching a b'],
    [{ tool: 'remove_file', pattern: '*' }, 'Allow remove_file for any input'],
    [{ tool: 'made_up_tool', pattern: '*' }, 'Allow made_up_tool for any input'],
    [{ tool: 'mcp__lonely', pattern: '*' }, 'Allow mcp__lonely for any input'],
    [{ tool: 'mcp__s__t', pattern: 'x' }, 'Allow mcp__s__t matching x']
  ])('never describes %j as a grant, because main would not honor it', (input, text) => {
    const described = describePermissionRule(input)
    expect(described.kind).toBe('unknown')
    expect(described.text).toBe(text)
    expect(described.detail).toContain('allows nothing')
  })
})

describe('mergeRules', () => {
  it('shows one line for edit_file and write_file rules and removes them together', () => {
    const rows = mergeRules([
      rule({ id: 'a', tool: 'edit_file', pattern: '*', createdAt: 10 }),
      rule({ id: 'b', tool: 'write_file', pattern: '*', createdAt: 30 }),
      rule({ id: 'c', tool: 'run_command', pattern: 'npm test', createdAt: 20 })
    ])
    expect(rows.map((row) => [row.ids, row.text.text, row.createdAt])).toEqual([
      [['a', 'b'], 'Edit and create files in the project', 30],
      [['c'], 'Run npm test', 20]
    ])
  })

  it('keeps unrecognized rules apart, one line each', () => {
    const rows = mergeRules([rule({ id: 'x', tool: 'weird', pattern: '*' }), rule({ id: 'y', tool: 'weird', pattern: '*' })])
    expect(rows.map((row) => row.ids)).toEqual([['x'], ['y']])
  })

  it('returns nothing for no rules', () => {
    expect(mergeRules([])).toEqual([])
  })
})

describe('groupRulesByProject', () => {
  const rules = [
    rule({ id: 'old', workspace: 'C:\\code\\aurora-site', tool: 'web_fetch', pattern: 'a.dev', createdAt: 100 }),
    rule({ id: 'cur1', workspace: 'C:\\code\\lumen-web', createdAt: 50 }),
    rule({ id: 'new', workspace: 'C:\\code\\ml-pipeline', tool: 'run_command', pattern: 'pytest', createdAt: 900 }),
    rule({ id: 'cur2', workspace: 'c:/code/lumen-web/', tool: 'edit_file', pattern: '*', createdAt: 60 })
  ]

  it('lists the selected project first, then the others by what was saved last', () => {
    const groups = groupRulesByProject(rules, new Set(['cur1', 'cur2']))
    expect(groups.map((group) => [group.workspace, group.current])).toEqual([
      ['C:\\code\\lumen-web', true],
      ['C:\\code\\ml-pipeline', false],
      ['C:\\code\\aurora-site', false]
    ])
  })

  it('treats the same folder written two ways as one project', () => {
    const [selected] = groupRulesByProject(rules, new Set(['cur1']))
    expect(selected!.rows.flatMap((row) => row.ids).sort()).toEqual(['cur1', 'cur2'])
    expect(selected!.current).toBe(true)
  })

  it('has no current project when main reports none', () => {
    expect(groupRulesByProject(rules, new Set()).some((group) => group.current)).toBe(false)
  })

  it('returns no groups for no rules', () => {
    expect(groupRulesByProject([], new Set())).toEqual([])
  })
})
