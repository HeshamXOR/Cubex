import { describe, expect, it } from 'vitest'
import { buildHarnessSystemPrompt } from './systemPrompt'

const tools = (names: string[]) => names.map((name) => ({ name, inputSchema: { type: 'object' as const } }))

describe('who the model is told it is', () => {
  it('names the model the picker shows and its maker, and says Cubex is the app', () => {
    const prompt = buildHarnessSystemPrompt({ tools: [], mode: 'default', model: { name: 'Claude Sonnet 5.5', id: 'claude-sonnet-5-5', vendor: 'Anthropic' } })
    expect(prompt.startsWith('You are Claude Sonnet 5.5 (model id claude-sonnet-5-5), made by Anthropic, working with the user inside Cubex')).toBe(true)
    expect(prompt).toContain('Cubex is the app you run in, not your name or your maker')
  })

  it('never renames the model, and never makes a model-sounding claim for one it knows nothing about', () => {
    for (const model of [undefined, { name: 'my-finetune-v2' }]) {
      const prompt = buildHarnessSystemPrompt({ tools: [], mode: 'default', ...(model ? { model } : {}) })
      expect(prompt).not.toMatch(/You are Cubex/)
      expect(prompt).not.toMatch(/made by/)
      expect(prompt.startsWith(model ? 'You are my-finetune-v2, working with the user inside Cubex' : 'You are working with the user inside Cubex')).toBe(true)
    }
  })
})

describe('harness system instructions', () => {
  it('does not advertise tools or local project access when none are registered', () => {
    const prompt = buildHarnessSystemPrompt({ tools: [], mode: 'default' })
    expect(prompt).toContain('No tools are registered')
    expect(prompt).toContain('No workspace is selected')
    expect(prompt).not.toContain('Use run_command')
    expect(prompt).not.toContain('Submit the full Markdown plan with exit_plan_mode')
  })

  it('makes rejection and Markdown artifact ownership explicit in plan mode', () => {
    const prompt = buildHarnessSystemPrompt({ tools: tools(['exit_plan_mode', 'read_file']), mode: 'plan', workspace: 'I:\\Cubex' })
    expect(prompt).toContain('Cubex saves it as a .md document')
    expect(prompt).toContain('Rejection is not approval')
    expect(prompt).toContain('Do not edit project files')
    expect(prompt).toContain('File-tool paths are relative')
  })

  it('replaces planning constraints after approval without discarding user context', () => {
    const options = { tools: tools(['exit_plan_mode', 'edit_file']), userInstructions: 'Use TypeScript.', projectInstructions: 'Keep the public API stable.' }
    const plan = buildHarnessSystemPrompt({ ...options, mode: 'plan' })
    const approved = buildHarnessSystemPrompt({ ...options, mode: 'acceptEdits' })
    expect(plan).toContain('Active mode: PLAN')
    expect(approved).not.toContain('Active mode: PLAN')
    expect(approved).not.toContain('Do not edit project files')
    expect(approved).toContain('Other side effects')
    expect(approved).toContain('Use TypeScript.')
    expect(approved).toContain('Keep the public API stable.')
  })

  it('describes the actual shell and isolated subagent limits', () => {
    const prompt = buildHarnessSystemPrompt({ tools: tools(['run_command', 'delegate_to_subagent', 'glob_files']), mode: 'default', platform: 'win32' })
    expect(prompt).toContain('cmd.exe')
    expect(prompt).toContain('does not see the parent conversation')
    expect(prompt).toContain('No project or saved-plan tools are available')
    expect(prompt).toContain('Find paths with glob_files')
    expect(prompt).not.toContain('Use write_file')
  })

  it('describes available research subagents and guarded file removal accurately', () => {
    const prompt = buildHarnessSystemPrompt({ tools: tools(['delegate_to_subagent', 'read_file', 'edit_file', 'remove_file']), mode: 'acceptEdits' })
    expect(prompt).toContain('bounded read-only task tools')
    expect(prompt).toContain('Child reads do not satisfy your own read-before-edit requirements')
    expect(prompt).toContain('never removes directories recursively')
    expect(prompt).toContain('current full read and permission review')
  })

  it('provides exact source chunks without duplicating or losing prompt content', () => {
    let sections: Array<{ id: string; text: string }> = []
    const prompt = buildHarnessSystemPrompt({ tools: tools(['skill']), mode: 'plan', userInstructions: 'Use TypeScript.',
      projectInstructions: 'Read AGENTS.md.', skillsCatalog: 'Code review', planContext: 'Saved revision',
      onSections: (value) => { sections = value }
    })
    expect(sections.map((section) => section.text).join('')).toBe(prompt)
    expect(new Set(sections.map((section) => section.id))).toEqual(new Set(['harness', 'user', 'project', 'skills', 'plans']))
  })

  it('does not advertise a skill catalog when its loader is unavailable', () => {
    const prompt = buildHarnessSystemPrompt({ tools: [], mode: 'default', skillsCatalog: 'Hidden skill catalog' })
    expect(prompt).not.toContain('Hidden skill catalog')
    expect(prompt).not.toContain('call skill')
    expect(prompt).not.toContain('source-library maintenance')
  })

  it.each([['skill'], ['skill', 'run_command']])('keeps bundled maintenance references distinct from installed capabilities: %j', (...registered) => {
    const prompt = buildHarnessSystemPrompt({ tools: tools(registered), mode: 'default', workspace: 'I:\\another-project' })
    expect(prompt).toContain('source-library checkout, not the active project')
    expect(prompt).toContain('does not install these commands or provide an execution tool')
    expect(prompt).toContain('their files and dependencies exist in the task workspace and run_command is available and permitted')
    expect(prompt).toContain('never claim that validation ran without its actual result')
  })
})
