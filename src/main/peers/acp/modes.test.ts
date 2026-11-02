import { describe, expect, it } from 'vitest'
import { chooseMode, classifyMode, isCareful, taskReadiness, type AcpMode } from './modes'

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

  it('refuses an agent that is in a mode that does not ask and has no other', () => {
    expect(chooseMode('yolo', [m('yolo', 'YOLO'), m('auto', 'Auto')])).toEqual({ action: 'refuse', current: m('yolo', 'YOLO') })
    expect(chooseMode('bypassPermissions', [m('bypassPermissions', 'Bypass Permissions')])).toEqual({ action: 'refuse', current: m('bypassPermissions', 'Bypass Permissions') })
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

  it.each(['opencode', 'copilot', 'cursor'])('refuses %s: it has no mode in which it asks first', (agent) => {
    const choice = chooseMode(AGENTS[agent]![0]!.id, AGENTS[agent]!, 'work')
    expect(choice).toMatchObject({ action: 'refuse', why: 'nothing-asks' })
    expect(choice.action === 'refuse' && choice.why === 'nothing-asks' ? choice.offered : []).toEqual(AGENTS[agent])
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
})
