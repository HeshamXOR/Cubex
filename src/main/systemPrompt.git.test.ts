import { describe, expect, it } from 'vitest'
import { buildHarnessSystemPrompt } from './systemPrompt'

const tools = (names: string[]) => names.map((name) => ({ name, inputSchema: { type: 'object' as const } }))

describe('git guidance in the system prompt', () => {
  it('points the model at the git tools and names what is not available', () => {
    const prompt = buildHarnessSystemPrompt({ tools: tools(['run_command', 'git_status', 'git_commit', 'git_branch']), mode: 'default', workspace: 'I:\\Cubex' })
    expect(prompt).toContain('prefer git_status, git_diff, git_log, git_show and git_blame')
    expect(prompt).toContain('There are no tools for push, reset, clean, rebase, force or stash')
    expect(prompt).toContain('Call git_status before git_commit')
  })

  it('says nothing about git tools when they are not registered', () => {
    const prompt = buildHarnessSystemPrompt({ tools: tools(['run_command', 'read_file']), mode: 'default', workspace: 'I:\\Cubex' })
    expect(prompt).not.toContain('git_status')
    expect(prompt).not.toContain('git_commit')
  })
})
