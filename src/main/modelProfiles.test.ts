import { describe, expect, it } from 'vitest'
import { namesSkill, profileFor, readProfileSetting, toolsToDrop, type HarnessProfile } from './modelProfiles'

describe('profileFor', () => {
  // [model id, tier, edit tool]
  it.each([
    ['claude-sonnet-4-5', 'full', 'edit_file'],
    ['claude-haiku-4-5', 'full', 'edit_file'],
    ['gpt-5', 'full', 'apply_patch'],
    ['gpt-5-codex', 'full', 'apply_patch'],
    ['gpt-4.1', 'full', 'apply_patch'],
    ['o3', 'full', 'apply_patch'],
    ['o4-mini', 'full', 'apply_patch'],
    ['gpt-4o', 'full', 'edit_file'],
    ['gemini-2.5-pro', 'full', 'edit_file'],
    ['gemini-2.5-flash', 'full', 'edit_file'],
    ['grok-4', 'full', 'edit_file'],
    ['acme-frontier-1', 'full', 'edit_file'],
    ['deepseek-v4.1-flash', 'lean', 'edit_file'],
    ['free/deepseek-v4.1-flash', 'lean', 'edit_file'],
    ['qwen3-coder', 'lean', 'edit_file'],
    ['meta/llama-3.3-70b-instruct', 'lean', 'edit_file'],
    ['nvidia/llama-3.1-nemotron-70b-instruct', 'lean', 'edit_file'],
    ['moonshotai/kimi-k2', 'lean', 'edit_file'],
    ['glm-4.6', 'lean', 'edit_file'],
    ['mistralai/mistral-small-3.2', 'lean', 'edit_file'],
    ['microsoft/phi-4', 'lean', 'edit_file'],
    ['google/gemma-3-27b-it', 'lean', 'edit_file'],
    ['gpt-oss-120b', 'lean', 'edit_file'],
    ['gemini-2.5-flash-lite', 'lean', 'edit_file'],
    ['gpt-5-nano', 'lean', 'apply_patch']
  ] as const)('%s is %s with %s', (modelId, tier, editTool) => {
    const profile = profileFor({ modelId })
    expect(profile.tier).toBe(tier)
    expect(profile.editTool).toBe(editTool)
    expect(profile.parallelTools).toBe(tier === 'full')
  })

  it('treats anything served by a local runtime as lean, known or not', () => {
    expect(profileFor({ providerKind: 'llamacpp', modelId: 'unsloth/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf' }).tier).toBe('lean')
    expect(profileFor({ providerKind: 'ollama', modelId: 'my-finetune' }).tier).toBe('lean')
    expect(profileFor({ providerKind: 'lmstudio', modelId: 'anything' }).tier).toBe('lean')
    expect(profileFor({ modelId: 'my-finetune', isLocal: true }).tier).toBe('lean')
    expect(profileFor({ providerKind: 'openai-compat', modelId: 'my-finetune' }).tier).toBe('full')
  })

  it('reads the picker name as well as the id, and a small parameter count as lean', () => {
    expect(profileFor({ modelId: 'ep-20250101', displayName: 'DeepSeek V3' }).tier).toBe('lean')
    expect(profileFor({ modelId: 'custom-7b', parameterCount: 7 }).tier).toBe('lean')
    expect(profileFor({ modelId: 'custom-big', parameterCount: 400 }).tier).toBe('full')
  })

  it('lets the setting override the detected tier for every model, but not the edit tool', () => {
    expect(profileFor({ modelId: 'claude-sonnet-4-5', setting: 'lean' }).tier).toBe('lean')
    expect(profileFor({ modelId: 'deepseek-v4.1-flash', setting: 'full' }).tier).toBe('full')
    expect(profileFor({ modelId: 'qwen3-coder', setting: 'auto' }).tier).toBe('lean')
    expect(profileFor({ modelId: 'gpt-5', setting: 'lean' }).editTool).toBe('apply_patch')
  })

  it('suggests a temperature only for models that do badly at the default, never for thinking ones', () => {
    expect(profileFor({ modelId: 'qwen3-coder' }).temperature).toBe(0.7)
    expect(profileFor({ modelId: 'moonshotai/kimi-k2' }).temperature).toBe(0.6)
    expect(profileFor({ modelId: 'meta/llama-3.3-70b-instruct' }).temperature).toBe(0.6)
    expect(profileFor({ modelId: 'moonshotai/kimi-k2-thinking' }).temperature).toBeUndefined()
    expect(profileFor({ modelId: 'claude-sonnet-4-5' }).temperature).toBeUndefined()
    expect(profileFor({ modelId: 'o3' }).temperature).toBeUndefined()
  })

  it('reads an unknown setting as auto', () => {
    expect(readProfileSetting('lean')).toBe('lean')
    expect(readProfileSetting('full')).toBe('full')
    expect(readProfileSetting('turbo')).toBe('auto')
    expect(readProfileSetting(undefined)).toBe('auto')
  })
})

const EVERYTHING = [
  'read_file', 'list_files', 'glob_files', 'search_files', 'write_file', 'edit_file', 'multi_edit', 'apply_patch', 'remove_file',
  'run_command', 'read_command_output', 'task_output', 'task_input', 'task_stop', 'task_list',
  'git_status', 'git_diff', 'git_log', 'git_show', 'git_blame', 'git_commit', 'git_branch',
  'web_fetch', 'web_search', 'todo_write', 'ask_user_question', 'read_plan', 'skill',
  'delegate_to_subagent', 'consult_agent', 'delegate_task', 'goal_update', 'exit_plan_mode', 'mcp__docs__search'
]
const kept = (profile: HarnessProfile, context = {}, names: string[] = EVERYTHING): string[] =>
  names.filter((name) => !toolsToDrop(names, profile, context).has(name))
const CLAUDE = profileFor({ modelId: 'claude-sonnet-4-5' })
const GPT = profileFor({ modelId: 'gpt-5' })
const QWEN = profileFor({ modelId: 'qwen3-coder' })

describe('toolsToDrop', () => {
  it('shows a full-tier model only its own edit tool, and multi_edit only beside edit_file', () => {
    const claude = kept(CLAUDE)
    expect(claude).toContain('edit_file')
    expect(claude).toContain('multi_edit')
    expect(claude).not.toContain('apply_patch')
    const gpt = kept(GPT)
    expect(gpt).toContain('apply_patch')
    expect(gpt).not.toContain('edit_file')
    expect(gpt).not.toContain('multi_edit')
    // Everything else of the full set is untouched.
    expect(EVERYTHING.length - claude.length).toBe(1)
    for (const profile of [CLAUDE, GPT]) {
      expect(kept(profile)).toEqual(expect.arrayContaining(['write_file', 'remove_file', 'skill', 'git_commit', 'delegate_to_subagent']))
    }
  })

  it('cuts a lean set to the essentials', () => {
    const lean = kept(QWEN)
    for (const gone of ['multi_edit', 'apply_patch', 'git_commit', 'git_branch', 'git_log', 'git_show', 'git_blame',
      'delegate_to_subagent', 'consult_agent', 'delegate_task', 'task_input', 'read_plan', 'skill']) {
      expect(lean).not.toContain(gone)
    }
    expect(lean).toEqual(expect.arrayContaining(['read_file', 'edit_file', 'write_file', 'remove_file', 'run_command', 'git_status', 'git_diff', 'task_output', 'task_stop', 'web_fetch', 'todo_write']))
    expect(lean.length).toBeLessThan(EVERYTHING.length * 0.7)
  })

  it('never drops what a mode, a goal or the user depends on', () => {
    for (const planMode of [false, true]) {
      const lean = kept(QWEN, { planMode })
      expect(lean).toEqual(expect.arrayContaining(['exit_plan_mode', 'goal_update', 'ask_user_question', 'mcp__docs__search', 'read_command_output', 'todo_write']))
      expect(lean.includes('read_plan')).toBe(planMode)
    }
  })

  it('keeps the skill tool for a lean model only when the user named a skill', () => {
    expect(kept(QWEN, { skillNamed: true })).toContain('skill')
    expect(kept(QWEN, { skillNamed: false })).not.toContain('skill')
  })

  it('keeps apply_patch for a lean model that is trained on it, and the other editor when its own is missing', () => {
    const gptLean = kept({ ...GPT, tier: 'lean' })
    expect(gptLean).toContain('apply_patch')
    expect(gptLean).not.toContain('edit_file')
    const noPatch = EVERYTHING.filter((name) => name !== 'apply_patch')
    expect(kept(GPT, {}, noPatch)).toContain('edit_file')
  })
})

describe('namesSkill', () => {
  const skills = ['code-review', 'frontend-engineering', 'review']
  it('recognises $name and /name', () => {
    expect(namesSkill('Use $frontend-engineering to polish this screen', skills)).toBe(true)
    expect(namesSkill('/code-review the diff', skills)).toBe(true)
    expect(namesSkill('please run (/code-review) now', skills)).toBe(true)
  })
  it('recognises a name beside the word skill, but not a bare name or a path', () => {
    expect(namesSkill('apply the frontend-engineering skill here', skills)).toBe(true)
    expect(namesSkill('review this function for me', skills)).toBe(false)
    expect(namesSkill('open src/review/index.ts', skills)).toBe(false)
    expect(namesSkill('use $unknown-skill', skills)).toBe(false)
    expect(namesSkill('', skills)).toBe(false)
  })
})
