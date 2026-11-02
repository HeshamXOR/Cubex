import { describe, expect, it } from 'vitest'
import { buildHarnessSystemPrompt } from './systemPrompt'
import { profileFor, toolsToDrop } from './modelProfiles'

const tools = (names: string[]) => names.map((name) => ({ name, inputSchema: { type: 'object' as const } }))
const ALL = [
  'read_file', 'list_files', 'glob_files', 'search_files', 'write_file', 'edit_file', 'multi_edit', 'apply_patch', 'remove_file',
  'run_command', 'read_command_output', 'task_output', 'task_input', 'task_stop', 'task_list',
  'git_status', 'git_diff', 'git_log', 'git_show', 'git_blame', 'git_commit', 'git_branch',
  'web_fetch', 'web_search', 'todo_write', 'ask_user_question', 'skill', 'delegate_to_subagent', 'consult_agent'
]
const common = { mode: 'default' as const, workspace: 'I:\\Cubex', platform: 'win32', skillsCatalog: 'Available skills (instructions load on demand). Match the task to these descriptions; call `skill` with the relevant name before using its workflow.\n- code-review (bundled): Review a diff.' }

function promptFor(modelId: string, names = ALL, extra: object = {}): string {
  const profile = profileFor({ modelId })
  const drop = toolsToDrop(names, profile, { skillNamed: true })
  return buildHarnessSystemPrompt({ ...common, ...extra, tools: tools(names.filter((name) => !drop.has(name))), tier: profile.tier, parallelTools: profile.parallelTools })
}

describe('lean system prompt', () => {
  it('is shorter than the full one for the tools each model is shown', () => {
    const full = promptFor('claude-sonnet-4-5')
    const lean = promptFor('qwen3-coder')
    expect(lean.length).toBeLessThan(full.length * 0.8)
  })

  it('lists exactly the tools it is built from, in both tiers', () => {
    for (const model of ['claude-sonnet-4-5', 'gpt-5', 'qwen3-coder']) {
      const profile = profileFor({ modelId: model })
      const drop = toolsToDrop(ALL, profile, { skillNamed: true })
      const shown = ALL.filter((name) => !drop.has(name))
      const prompt = buildHarnessSystemPrompt({ ...common, tools: tools(shown), tier: profile.tier })
      const listed = prompt.split('## Available tools\n')[1]!.split('\n\n')[0]!.split('\n').filter((line) => line.startsWith('- ')).map((line) => line.slice(2))
      expect(listed).toEqual([...shown].sort())
    }
  })

  it('keeps the working agreement and the essential guidance for the tools it has', () => {
    const lean = promptFor('qwen3-coder')
    expect(lean).toContain('## Working agreement')
    expect(lean).toContain('Never claim to have read a file')
    expect(lean).toContain('Use edit_file')
    expect(lean).toContain('Use run_command')
    expect(lean).toContain('cmd.exe')
    expect(lean).toContain('Use ask_user_question')
    expect(lean).toContain('For Git inspection prefer git_status, git_diff')
  })

  it('does not describe tools the lean set removed', () => {
    const lean = promptFor('qwen3-coder')
    for (const gone of ['multi_edit', 'apply_patch', 'git_commit', 'git_branch', 'git_log', 'git_blame', 'task_input', 'delegate_to_subagent', 'consult_agent']) {
      expect(lean).not.toContain(gone)
    }
    expect(lean).not.toContain('source-library')
    expect(lean).not.toContain('backend-engineering/references')
  })

  it('tells a model that should not batch calls to go one at a time', () => {
    expect(promptFor('qwen3-coder')).toContain('Call one tool at a time')
    expect(promptFor('claude-sonnet-4-5')).not.toContain('Call one tool at a time')
  })

  it('is the same text for the same input', () => {
    expect(promptFor('qwen3-coder')).toBe(promptFor('qwen3-coder'))
    expect(promptFor('gpt-5')).toBe(promptFor('gpt-5'))
  })

  it('keeps plan mode and its hand-off tool', () => {
    const profile = profileFor({ modelId: 'qwen3-coder' })
    const prompt = buildHarnessSystemPrompt({ ...common, mode: 'plan', tools: tools(['read_file', 'exit_plan_mode']), tier: profile.tier })
    expect(prompt).toContain('Active mode: PLAN')
    expect(prompt).toContain('Submit the full Markdown plan with exit_plan_mode')
  })
})

describe('skill guidance', () => {
  it.each(['full', 'lean'] as const)('limits loading a skill to named or substantial matching work (%s)', (tier) => {
    const prompt = buildHarnessSystemPrompt({ ...common, tools: tools(['skill', 'read_file']), tier })
    expect(prompt).toContain('Call skill only when the user names one')
    expect(prompt).toMatch(/(Do not|Never) load a skill to answer a question/)
    expect(prompt).toMatch(/small (single-file )?edit/)
    expect(prompt).not.toContain('When a skill clearly applies, call skill')
    expect(prompt).not.toMatch(/call `?skill`? with the relevant name before using its workflow/)
  })

  it('asks for at most one skill unless another is needed, and keeps the resource guidance in the full tier only', () => {
    const full = buildHarnessSystemPrompt({ ...common, tools: tools(['skill']), tier: 'full' })
    const lean = buildHarnessSystemPrompt({ ...common, tools: tools(['skill']), tier: 'lean' })
    expect(full).toContain('Load one skill, and add another only when its separate workflow is needed')
    expect(lean).toContain('load at most one')
    expect(full).toContain('backend-engineering/references/api-design.md')
    expect(lean).not.toContain('backend-engineering/references/api-design.md')
  })

  it('swaps the catalog opener that tells the model to match every task, and keeps the entries', () => {
    const prompt = buildHarnessSystemPrompt({ ...common, tools: tools(['skill']) })
    expect(prompt).not.toContain('Match the task to these descriptions')
    expect(prompt).toContain('- code-review (bundled): Review a diff.')
  })
})
