import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ASKED_TOOLS, claudeArguments, claudeEnvironment, claudeTools, modelFrom, policySettings, writeSettingsFile } from './launch'

describe('the tools Claude Code is started with', () => {
  it('are the ones that read for a consultation', () => {
    expect(claudeTools('consult')).toEqual(['Read', 'Grep', 'Glob', 'LS'])
  })

  it('are the ones that change things too for a task, and none that start other agents, schedule work or change the folder', () => {
    const tools = claudeTools('work')
    for (const wanted of ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch']) expect(tools).toContain(wanted)
    for (const never of ['Task', 'Agent', 'EnterWorktree', 'ExitWorktree', 'Workflow', 'CronCreate', 'ScheduleWakeup', 'SendMessage', 'Skill', 'AskUserQuestion', 'ExitPlanMode']) expect(tools).not.toContain(never)
  })

  it('are all asked about, except the ones that touch nothing', () => {
    const touchNothing = new Set(['LS', 'MultiEdit', 'TodoWrite'])
    for (const tool of claudeTools('work')) expect(ASKED_TOOLS.includes(tool) || touchNothing.has(tool), tool).toBe(true)
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

  it('leave "co-authored by Claude" out of commits and pull requests', () => {
    expect(settings.attribution).toEqual({ commit: '', pr: '' })
    expect(settings.includeCoAuthoredBy).toBe(false)
  })
})

describe('the arguments', () => {
  const base = { settingsFile: 'C:\\Temp\\cubex-claude\\s-1\\settings.json' }

  it('make Claude Code speak its stream-json protocol and ask before it uses a tool', () => {
    const args = claudeArguments({ purpose: 'consult', ...base })
    expect(args).toEqual([
      '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
      '--permission-prompt-tool', 'stdio', '--permission-mode', 'default',
      '--setting-sources', 'user', '--settings', base.settingsFile,
      '--strict-mcp-config', '--no-session-persistence',
      '--tools', 'Read,Grep,Glob,LS'
    ])
  })

  it('never carry an option that skips the questions', () => {
    for (const purpose of ['consult', 'work'] as const) {
      const args = claudeArguments({ purpose, ...base }).join(' ')
      expect(args).not.toMatch(/dangerously|bypass|acceptEdits|--allowedTools|--allow-dangerously/)
    }
  })

  it('load the person\'s own settings and never the project\'s', () => {
    const args = claudeArguments({ purpose: 'work', ...base })
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('user')
  })

  it('give a task its tools', () => {
    const args = claudeArguments({ purpose: 'work', ...base })
    expect(args[args.indexOf('--tools') + 1]).toBe(claudeTools('work').join(','))
  })

  it('pass the model that was chosen', () => {
    expect(claudeArguments({ purpose: 'consult', ...base, model: 'sonnet' }).slice(-2)).toEqual(['--model', 'sonnet'])
    expect(claudeArguments({ purpose: 'consult', ...base }).includes('--model')).toBe(false)
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

  it.each([
    [undefined],
    [[]],
    [['--dangerously-skip-permissions']],
    [['--model']],
    [['--model', 'a b']],
    [['--model', '--settings']],
    [['--model', 'x;rm -rf']],
    [['--model', 'x'.repeat(200)]],
    [['--model=']]
  ])('%j is no model', (args) => {
    expect(modelFrom(args as string[] | undefined)).toBeUndefined()
  })
})

describe('the environment', () => {
  it('drops the markers of a host Claude Code, whatever their case, and keeps the rest', () => {
    const env = claudeEnvironment({ PATH: '/bin', CLAUDECODE: '1', claude_code_sse_port: '1234', CLAUDE_CODE_SESSION_ID: 'x', HOME: '/home/a' })
    expect(env).toMatchObject({ PATH: '/bin', HOME: '/home/a' })
    expect(Object.keys(env).filter((key) => /^claude/i.test(key))).toEqual(['CLAUDE_CODE_ENTRYPOINT'])
  })

  it('turns self-update off and names Cubex as what started it', () => {
    const env = claudeEnvironment({ DISABLE_AUTOUPDATER: '0', CLAUDE_CODE_ENTRYPOINT: 'cli' })
    expect(env.DISABLE_AUTOUPDATER).toBe('1')
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('cubex')
  })

  it('does not change what it was given', () => {
    const base = { CLAUDECODE: '1' }
    claudeEnvironment(base)
    expect(base).toEqual({ CLAUDECODE: '1' })
  })
})

describe('the settings file', () => {
  it('holds the rules, in a folder of its own that is removed afterwards', () => {
    const made = writeSettingsFile()
    expect(JSON.parse(readFileSync(made.file, 'utf8'))).toEqual(JSON.parse(JSON.stringify(policySettings())))
    expect(existsSync(made.file)).toBe(true)
    made.remove()
    expect(existsSync(made.file)).toBe(false)
    expect(() => made.remove()).not.toThrow()
  })

  it('is a different file each time, so two agents do not share one', () => {
    const one = writeSettingsFile()
    const two = writeSettingsFile()
    expect(one.file).not.toBe(two.file)
    one.remove()
    expect(existsSync(two.file)).toBe(true)
    two.remove()
  })
})
