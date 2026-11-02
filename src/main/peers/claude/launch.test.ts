
import { describe, expect, it } from 'vitest'
import { ASKED_TOOLS, claudeArguments, claudeEnvironment, claudeTools, modelFrom, policySettings } from './launch'

describe('the tools Claude Code is started with', () => {
  it('are the ones that read for a consultation', () => {
    expect(claudeTools('consult')).toEqual(['Read', 'Grep', 'Glob', 'LS'])
  })

  it('are the ones that change things too for a task, and none that start other agents, schedule work or change the folder', () => {
    const tools = claudeTools('work')
    for (const wanted of ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch']) expect(tools).toContain(wanted)
    for (const never of ['Task', 'Agent', 'EnterWorktree', 'ExitWorktree', 'Workflow', 'CronCreate', 'ScheduleWakeup', 'SendMessage', 'Skill', 'AskUserQuestion', 'ExitPlanMode']) expect(tools).not.toContain(never)
  })
})

describe('the rules Claude Code is held to', () => {
  const settings = policySettings() as { permissions: { ask: string[]; defaultMode: string; disableBypassPermissionsMode: string }; disableAllHooks: boolean; attribution: { commit: string; pr: string }; includeCoAuthoredBy: boolean }

  it('ask about every tool that reads, changes or reaches out, which wins over an "allow" in anyone\'s settings', () => {
    expect(settings.permissions.ask).toEqual([...ASKED_TOOLS])
    for (const tool of ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch']) expect(settings.permissions.ask).toContain(tool)
  })

  it('start in the mode that asks and cannot be moved to the one that never does', () => {
    expect(settings.permissions.defaultMode).toBe('default')
    expect(settings.permissions.disableBypassPermissionsMode).toBe('disable')
  })

  it('switch hooks off, because a hook can allow a tool without a question', () => {
    expect(settings.disableAllHooks).toBe(true)
  })
})

describe('the arguments', () => {
  const base = { settingsFile: 'C:\\Temp\\cubex-claude\\s-1\\settings.json' }

  it('never carry an option that skips the questions', () => {
    for (const purpose of ['consult', 'work'] as const) {
      const args = claudeArguments({ purpose, ...base }).join(' ')
      expect(args).not.toMatch(/dangerously|bypass|acceptEdits|--allowedTools|--allow-dangerously/)
    }
  })
})

describe('the model among an agent\'s arguments', () => {
  it.each([
    [['--model', 'sonnet'], 'sonnet'],
    [['-m', 'opus'], 'opus'],
    [['--model=claude-opus-4-1'], 'claude-opus-4-1'],
    [['--verbose', '--model', 'sonnet[1m]', '--other'], 'sonnet[1m]'],
    [['--model', 'bedrock/anthropic.claude-3:0'], 'bedrock/anthropic.claude-3:0']
  ])('%j is %s', (args, model) => {
    expect(modelFrom(args)).toBe(model)
  })
})

describe('the environment', () => {
  it('drops the markers of a host Claude Code, whatever their case, and keeps the rest', () => {
    const env = claudeEnvironment({ PATH: '/bin', CLAUDECODE: '1', claude_code_sse_port: '1234', CLAUDE_CODE_SESSION_ID: 'x', HOME: '/home/a' })
    expect(env).toMatchObject({ PATH: '/bin', HOME: '/home/a' })
    expect(Object.keys(env).filter((key) => /^claude/i.test(key))).toEqual(['CLAUDE_CODE_ENTRYPOINT'])
  })
})
