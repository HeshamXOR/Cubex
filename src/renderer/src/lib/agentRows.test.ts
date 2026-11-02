import { describe, expect, it } from 'vitest'
import { KNOWN_AGENTS, knownAgent, type AgentDetection, type KnownAgent } from '../../../shared/agentCatalog'
import { checkedAt, foundView, nodeLine, sortFound } from './agentRows'

const entry = (id: string) => knownAgent(id)!
const found = (id: string, over: Partial<AgentDetection> = {}): AgentDetection => ({
  id, found: true, path: `C:\\bin\\${id}.cmd`, version: '1.0.0', account: { state: 'unknown' }, probed: true, ...over
})
const here = { nodeFound: true, localOnly: false }

describe('an agent that is not installed', () => {
  it('says so, and offers nothing to sign in to', () => {
    const view = foundView(entry('codex'), undefined, here)
    expect(view).toMatchObject({ state: 'missing', account: 'Not installed', signIn: false })
    expect(view.capability).toBeUndefined()
    expect(foundView(entry('codex'), { id: 'codex', found: false, account: { state: 'unknown' }, probed: false }, here).state).toBe('missing')
  })
})

describe('an agent that is signed in', () => {
  const view = foundView(entry('claude-code'), found('claude-code', { account: { state: 'signed-in', label: 'Claude subscription', email: 'ada@example.com' } }), here)

  it('says who with', () => {
    expect(view.state).toBe('signed-in')
    expect(view.account).toBe('Signed in with Claude subscription (ada@example.com)')
  })

  it('offers no sign-in and nothing to do first', () => {
    expect(view.signIn).toBe(false)
    expect(view.hint).toBeUndefined()
    expect(view.blocked).toBe(false)
  })

  it('is added as a program Cubex talks to itself, which does everything, so the row says nothing more', () => {
    expect(view.connection).toEqual({ kind: 'acp', preset: 'claude-direct' })
    expect(view.capability).toBeUndefined()
    expect(view.where).toBeUndefined()
  })
})

describe('an agent that is not signed in', () => {
  it('offers the sign-in command the vendor documents', () => {
    const view = foundView(entry('codex'), found('codex', { account: { state: 'signed-out' } }), here)
    expect(view).toMatchObject({ state: 'signed-out', account: 'Not signed in', signIn: true })
    expect(view.hint).toBeUndefined()
  })

  it('does not offer it in local-only mode, where programs are not started', () => {
    const view = foundView(entry('codex'), found('codex', { account: { state: 'signed-out' }, probed: false }), { nodeFound: true, localOnly: true })
    expect(view.signIn).toBe(false)
  })
})

describe('an agent whose account Cubex cannot read', () => {
  it('says it cannot tell, and how to find out', () => {
    const view = foundView(entry('gemini'), found('gemini'), here)
    expect(view).toMatchObject({ state: 'unknown', account: 'Sign-in not checked', signIn: false })
    expect(view.hint).toBe('Add it and use Test to see whether it answers.')
  })

  it('still offers the sign-in command when the vendor has one', () => {
    expect(foundView(entry('opencode'), found('opencode'), here).signIn).toBe(true)
    expect(foundView(entry('cursor'), found('cursor'), here).signIn).toBe(true)
  })

  it('does not say it was unable to read it when it did not try', () => {
    const view = foundView(entry('gemini'), found('gemini', { probed: false }), { nodeFound: true, localOnly: true })
    expect(view.account).toBe('Sign-in not checked')
    expect(view.hint).toBeUndefined()
  })
})

describe('an agent that was found but did not run', () => {
  it('shows what went wrong in the place of the account, and offers no sign-in', () => {
    const view = foundView(entry('codex'), found('codex', { problem: 'Found, but it did not run: it took too long to answer.', probed: false }), here)
    expect(view).toMatchObject({ state: 'problem', account: 'Found, but it did not run: it took too long to answer.', signIn: false })
  })
})

describe('an agent found in an app', () => {
  it('says where, so a person who has the app and no command line sees why it is there', () => {
    const view = foundView(entry('claude-code'), found('claude-code', { via: 'the Claude desktop app', account: { state: 'signed-out' } }), here)
    expect(view.where).toBe('Found in the Claude desktop app')
    expect(view).toMatchObject({ state: 'signed-out', signIn: true, blocked: false })
  })

  it('says where when it did not run, too', () => {
    const view = foundView(entry('claude-code'), found('claude-code', { via: 'the Claude desktop app', problem: 'Found, but it did not run: broken.', probed: false }), here)
    expect(view).toMatchObject({ state: 'problem', where: 'Found in the Claude desktop app' })
  })

  it('says nothing about where for a program on PATH', () => {
    expect(foundView(entry('codex'), found('codex'), here).where).toBeUndefined()
  })
})

describe('without Node.js', () => {
  const nothing = { nodeFound: false, localOnly: false }

  it('still adds Claude Code in full, since Cubex starts it itself', () => {
    const view = foundView(entry('claude-code'), found('claude-code', { account: { state: 'signed-in', label: 'Claude subscription' } }), nothing)
    expect(view.connection).toEqual({ kind: 'acp', preset: 'claude-direct' })
    expect(view.capability).toBeUndefined()
    expect(view.blocked).toBe(false)
  })

  it('does not let Codex be added, since its only way in is the adapter', () => {
    const view = foundView(entry('codex'), found('codex', { account: { state: 'signed-in', label: 'ChatGPT account' } }), nothing)
    expect(view.blocked).toBe(true)
    expect(view.hint).toBe('Needs Node.js to run its adapter. Install Node.js, then choose Check again.')
  })

  it('does not need it for a program that speaks the protocol itself', () => {
    expect(foundView(entry('gemini'), found('gemini'), nothing).blocked).toBe(false)
  })

  it('does not need it for a command line that never used it', () => {
    const commandLine: KnownAgent = { id: 'tool', name: 'Tool', vendor: 'Vendor', programs: ['tool'], installUrl: 'https://example.com', connection: { kind: 'cli', preset: 'custom' } }
    const view = foundView(commandLine, found('tool'), nothing)
    expect(view.blocked).toBe(false)
    expect(view.capability).toBe('Gives opinions only.')
  })
})

describe('the order of the list', () => {
  it('puts what is installed first, each group in the order of the catalog', () => {
    const byId = new Map([found('codex'), found('goose'), { id: 'gemini', found: false, account: { state: 'unknown' as const }, probed: false }].map((agent) => [agent.id, agent] as const))
    const ids = sortFound(byId).map((agent) => agent.id)
    expect(ids.slice(0, 2)).toEqual(['codex', 'goose'])
    expect(ids).toHaveLength(KNOWN_AGENTS.length)
    expect(ids.slice(2)).toEqual(KNOWN_AGENTS.map((agent) => agent.id).filter((id) => id !== 'codex' && id !== 'goose'))
  })

  it('keeps the catalog order when nothing has been checked', () => {
    expect(sortFound(new Map()).map((agent) => agent.id)).toEqual(KNOWN_AGENTS.map((agent) => agent.id))
  })
})

describe('the sentence about Node.js', () => {
  it('names the version when it is known, and says what it is for', () => {
    expect(nodeLine({ found: true, version: '22.11.0' })).toBe('Node.js 22.11.0 is installed. Codex runs through an adapter that it starts.')
    expect(nodeLine({ found: true })).toBe('Node.js is installed. Codex runs through an adapter that it starts.')
  })

  it('says what is lost without it, and what to do', () => {
    expect(nodeLine({ found: false })).toBe('Node.js is not installed. Codex needs it. Install Node.js, then choose Check again.')
  })
})

describe('when the check was made', () => {
  it('is a clock time', () => {
    expect(checkedAt(Date.UTC(2026, 9, 10, 14, 32), 'en-GB')).toMatch(/^\d{2}:\d{2}$/)
  })
})
