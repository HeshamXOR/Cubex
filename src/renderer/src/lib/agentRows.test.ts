import { describe, expect, it } from 'vitest'
import { KNOWN_AGENTS, knownAgent, type AgentDetection } from '../../../shared/agentCatalog'
import { foundView, sortFound } from './agentRows'

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

  it('offers no sign-in and nothing to do first', () => {
    expect(view.signIn).toBe(false)
    expect(view.hint).toBeUndefined()
    expect(view.blocked).toBe(false)
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

})

describe('the order of the list', () => {
  it('puts what is installed first, each group in the order of the catalog', () => {
    const byId = new Map([found('codex'), found('goose'), { id: 'gemini', found: false, account: { state: 'unknown' as const }, probed: false }].map((agent) => [agent.id, agent] as const))
    const ids = sortFound(byId).map((agent) => agent.id)
    expect(ids.slice(0, 2)).toEqual(['codex', 'goose'])
    expect(ids).toHaveLength(KNOWN_AGENTS.length)
    expect(ids.slice(2)).toEqual(KNOWN_AGENTS.map((agent) => agent.id).filter((id) => id !== 'codex' && id !== 'goose'))
  })

})
