import { describe, expect, it } from 'vitest'
import { chooseMode, classifyMode, isCareful, modeNames, readinessNote, taskReadiness, type AcpMode } from './modes'

const m = (id: string, name = id): AcpMode => ({ id, name })

describe('knowing a mode by its words', () => {
  it.each<[string, string, string]>([
    ['read-only', 'Read Only', 'readonly'],
    ['plan', 'Plan Mode', 'plan'],
    ['https://agentclientprotocol.com/protocol/session-modes#plan', 'Plan', 'plan'],
    ['ask', 'Ask', 'ask'],
    ['chat', 'Chat', 'chat'],
    ['default', 'Default', 'asks'],
    ['approve', 'Approve', 'asks'],
    ['smart_approve', 'Smart approve', 'asks'],
    ['bypassPermissions', 'Bypass Permissions', 'unsafe'],
    ['acceptEdits', 'Accept Edits', 'unsafe'],
    ['accept_edits', 'Accept edits', 'unsafe'],
    ['dontAsk', 'Don\'t Ask', 'unsafe'],
    ['yolo', 'YOLO', 'unsafe'],
    ['autoEdit', 'Auto Edit', 'unsafe'],
    ['auto', 'Auto', 'unsafe'],
    ['full-access', 'Full Access', 'unsafe'],
    ['https://agentclientprotocol.com/protocol/session-modes#autopilot', 'Autopilot', 'unsafe'],
    ['build', 'Build', 'unknown'],
    ['agent', 'Agent', 'unknown'],
    ['code', 'Code', 'unknown'],
    ['autonomous', 'Autonomous', 'unknown']
  ])('%s (%s) is %s', (id, name, kind) => {
    expect(classifyMode(m(id, name))).toBe(kind)
  })

  it('only trusts the modes that look first or ask first', () => {
    expect(['readonly', 'plan', 'ask', 'chat', 'asks'].every((kind) => isCareful(kind as never))).toBe(true)
    expect(isCareful('unsafe')).toBe(false)
    expect(isCareful('unknown')).toBe(false)
  })
})

/** The modes the agents in the ACP registry offer, as they report them. */
const AGENTS: Record<string, AcpMode[]> = {
  claude: [m('default', 'Default'), m('acceptEdits', 'Accept Edits'), m('plan', 'Plan Mode'), m('dontAsk', 'Don\'t Ask'), m('bypassPermissions', 'Bypass Permissions')],
  codex: [m('read-only', 'Read Only'), m('auto', 'Auto'), m('full-access', 'Full Access')],
  gemini: [m('default', 'Default'), m('autoEdit', 'Auto Edit'), m('yolo', 'YOLO'), m('plan', 'Plan')],
  opencode: [m('build', 'Build'), m('plan', 'Plan')],
  copilot: [
    m('https://agentclientprotocol.com/protocol/session-modes#agent', 'Agent'),
    m('https://agentclientprotocol.com/protocol/session-modes#plan', 'Plan'),
    m('https://agentclientprotocol.com/protocol/session-modes#autopilot', 'Autopilot')
  ],
  cursor: [m('agent', 'Agent'), m('plan', 'Plan'), m('ask', 'Ask')],
  goose: [m('auto', 'Auto'), m('approve', 'Approve'), m('smart_approve', 'Smart approve'), m('chat', 'Chat')]
}

describe('choosing a mode', () => {
  it.each<[string, string, string]>([
    ['claude', 'default', 'plan'],
    ['claude', 'bypassPermissions', 'plan'],
    ['codex', 'auto', 'read-only'],
    ['codex', 'full-access', 'read-only'],
    ['gemini', 'default', 'plan'],
    ['gemini', 'yolo', 'plan'],
    ['opencode', 'build', 'plan'],
    ['copilot', 'https://agentclientprotocol.com/protocol/session-modes#agent', 'https://agentclientprotocol.com/protocol/session-modes#plan'],
    ['cursor', 'agent', 'plan'],
    ['cursor', 'ask', 'plan'],
    ['goose', 'auto', 'chat'],
    ['goose', 'smart_approve', 'chat']
  ])('moves %s from %s to %s', (agent, current, wanted) => {
    expect(chooseMode(current, AGENTS[agent]!)).toEqual({ action: 'set', mode: expect.objectContaining({ id: wanted }) })
  })

  it('stays where it is when that is as careful as it gets', () => {
    expect(chooseMode('plan', AGENTS.claude!)).toEqual({ action: 'keep' })
    expect(chooseMode('read-only', AGENTS.codex!)).toEqual({ action: 'keep' })
    expect(chooseMode('default', [m('default', 'Default'), m('auto', 'Auto')])).toEqual({ action: 'keep' })
    expect(chooseMode('ask', [m('ask', 'Ask'), m('agent', 'Agent')])).toEqual({ action: 'keep' })
  })

  it('moves a mode that asks first to one that cannot change anything', () => {
    expect(chooseMode('default', [m('default'), m('plan')])).toEqual({ action: 'set', mode: m('plan') })
  })

  it('moves an agent whose current mode is not on its own list', () => {
    expect(chooseMode('mystery', [m('plan'), m('yolo')])).toEqual({ action: 'set', mode: m('plan') })
  })

  it('refuses an agent that is in a mode that does not ask and has no other', () => {
    expect(chooseMode('yolo', [m('yolo', 'YOLO'), m('auto', 'Auto')])).toEqual({ action: 'refuse', current: m('yolo', 'YOLO') })
    expect(chooseMode('bypassPermissions', [m('bypassPermissions', 'Bypass Permissions')])).toEqual({ action: 'refuse', current: m('bypassPermissions', 'Bypass Permissions') })
  })

  it('refuses a mode it cannot tell is careful, when there is none it can', () => {
    expect(chooseMode('code', [m('code', 'Code')])).toEqual({ action: 'refuse', current: m('code', 'Code') })
    expect(chooseMode('build', [m('build', 'Build'), m('code', 'Code')])).toEqual({ action: 'refuse', current: m('build', 'Build') })
  })

  it('has nothing to say about an agent without modes', () => {
    expect(chooseMode(undefined, [])).toEqual({ action: 'keep' })
    expect(chooseMode('x', [])).toEqual({ action: 'keep' })
    // Modes that do not include the current one, none of them careful: judged by its answers alone.
    expect(chooseMode('gone', [m('yolo', 'YOLO')])).toEqual({ action: 'keep' })
  })
})

describe('choosing a mode for a task', () => {
  it.each<[string, string, string]>([
    ['claude', 'plan', 'default'],
    ['claude', 'bypassPermissions', 'default'],
    ['codex', 'auto', 'read-only'],
    ['codex', 'full-access', 'read-only'],
    ['gemini', 'yolo', 'default'],
    ['goose', 'auto', 'approve']
  ])('moves %s from %s to %s, so that it asks before it changes things', (agent, current, wanted) => {
    expect(chooseMode(current, AGENTS[agent]!, 'work')).toEqual({ action: 'set', mode: expect.objectContaining({ id: wanted }) })
  })

  it('stays in a mode that asks', () => {
    expect(chooseMode('default', AGENTS.claude!, 'work')).toEqual({ action: 'keep' })
    expect(chooseMode('read-only', AGENTS.codex!, 'work')).toEqual({ action: 'keep' })
    expect(chooseMode('approve', AGENTS.goose!, 'work')).toEqual({ action: 'keep' })
  })

  it('prefers a mode that asks to a read-only one', () => {
    expect(chooseMode('read-only', [m('read-only', 'Read only'), m('default', 'Default')], 'work')).toEqual({ action: 'set', mode: m('default', 'Default') })
  })

  it.each(['opencode', 'copilot', 'cursor'])('refuses %s: it has no mode in which it asks first', (agent) => {
    const choice = chooseMode(AGENTS[agent]![0]!.id, AGENTS[agent]!, 'work')
    expect(choice).toMatchObject({ action: 'refuse', why: 'nothing-asks' })
    expect(choice.action === 'refuse' && choice.why === 'nothing-asks' ? choice.offered : []).toEqual(AGENTS[agent])
  })

  it('does not count plan, chat or ask modes, which cannot change anything', () => {
    expect(chooseMode('plan', [m('plan'), m('chat'), m('ask')], 'work')).toMatchObject({ action: 'refuse', why: 'nothing-asks' })
  })

  it('has nothing to say about an agent without modes', () => {
    expect(chooseMode(undefined, [], 'work')).toEqual({ action: 'keep' })
  })

  it('still looks only for the most careful mode for a consultation', () => {
    expect(chooseMode('default', AGENTS.claude!, 'consult')).toEqual({ action: 'set', mode: expect.objectContaining({ id: 'plan' }) })
  })
})

describe('whether an agent can take a task', () => {
  it.each<[string, string]>([
    ['claude', 'default'],
    ['codex', 'read-only'],
    ['gemini', 'default'],
    ['goose', 'approve']
  ])('%s would work in its %s mode', (agent, wanted) => {
    expect(taskReadiness(AGENTS[agent]!)).toEqual({ ready: true, mode: expect.objectContaining({ id: wanted }) })
  })

  it.each(['opencode', 'copilot', 'cursor'])('%s offers no mode that asks first, so it can only take tasks that read', (agent) => {
    expect(taskReadiness(AGENTS[agent]!)).toEqual({ ready: false, offered: AGENTS[agent] })
  })

  it('has nothing against an agent that offers no modes: its answers are all there is to judge', () => {
    expect(taskReadiness([])).toEqual({ ready: true })
  })

  it('does not depend on the mode the agent happens to start in', () => {
    expect(taskReadiness([m('yolo', 'YOLO'), m('default', 'Default')])).toEqual({ ready: true, mode: m('default', 'Default') })
  })
})

describe('what a test says about taking tasks', () => {
  it('names the mode a task would run in', () => {
    expect(readinessNote(taskReadiness(AGENTS.claude!))).toBe('Can take any kind of task. It works in its "Default" mode, which asks before it changes things.')
  })

  it('says what an agent that never asks can still do, and which modes it offers', () => {
    expect(readinessNote(taskReadiness(AGENTS.opencode!))).toBe(
      'Can take research and review tasks, but not tasks that change the project: it has no mode in which it asks before it changes things (it offers: Build, Plan).'
    )
  })

  it('says an agent without modes is judged by its questions', () => {
    expect(readinessNote(taskReadiness([]))).toBe('Can take any kind of task. It offers no modes, so Cubex judges it by the questions it asks.')
  })
})

describe('the names of modes in a sentence', () => {
  it('are listed in order', () => {
    expect(modeNames([m('a', 'Build'), m('b', 'Plan')])).toBe('Build, Plan')
  })

  it('are cut at a few, with how many are left', () => {
    expect(modeNames(Array.from({ length: 9 }, (_, index) => m(`m${index}`, `Mode ${index}`)))).toBe('Mode 0, Mode 1, Mode 2, Mode 3, Mode 4, Mode 5 and 3 more')
  })

  it('are plain and short whatever the agent called them', () => {
    expect(modeNames([m('a', 'Two\u0007  words\nhere')])).toBe('Two words here')
    expect(modeNames([m('a', 'x'.repeat(60))])).toBe(`${'x'.repeat(40)}…`)
  })
})
