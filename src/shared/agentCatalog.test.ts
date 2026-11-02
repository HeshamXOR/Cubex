import { describe, expect, it } from 'vitest'
import { ACP_PRESETS, PEER_PRESETS, newAcpPeer, newCliPeer, type PeerConfig } from './peers'
import {
  KNOWN_AGENTS, catalogIdOfPeer, connectionFor, connectionNeedsNode, describeAccount, knownAgent, signInCommand
} from './agentCatalog'

const acp = (over: Partial<PeerConfig> & { command: string; preset?: string }): PeerConfig =>
  ({ kind: 'acp', id: 'x', name: 'X', enabled: true, preset: 'custom', ...over }) as PeerConfig
const cli = (over: Partial<PeerConfig> & { command: string; preset?: string }): PeerConfig =>
  ({ kind: 'cli', id: 'x', name: 'X', enabled: true, preset: 'custom', ...over }) as PeerConfig

describe('the catalog', () => {
  it('lists each agent once, with a program to look for and somewhere to get it', () => {
    const ids = KNOWN_AGENTS.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of KNOWN_AGENTS) {
      expect(entry.programs.length, entry.id).toBeGreaterThan(0)
      expect(entry.installUrl, entry.id).toMatch(/^https:\/\//)
      expect(entry.name.trim(), entry.id).not.toBe('')
    }
  })

  it('only offers connections Cubex can set up', () => {
    const acpIds = new Set(ACP_PRESETS.map((preset) => preset.id))
    const cliIds = new Set(PEER_PRESETS.map((preset) => preset.id))
    for (const entry of KNOWN_AGENTS) {
      for (const connection of [entry.connection, entry.withoutNode, ...(entry.alsoConnections ?? [])]) {
        if (!connection) continue
        expect(connection.kind === 'acp' ? acpIds.has(connection.preset) : cliIds.has(connection.preset), `${entry.id}: ${connection.preset}`).toBe(true)
      }
    }
  })

  it('finds an agent by its key', () => {
    expect(knownAgent('codex')?.name).toBe('Codex')
    expect(knownAgent('nobody')).toBeUndefined()
  })

  it('has a command that signs in only where the vendor documents one', () => {
    expect(signInCommand(knownAgent('claude-code')!)).toBe('claude auth login')
    expect(signInCommand(knownAgent('codex')!)).toBe('codex login')
    expect(signInCommand(knownAgent('opencode')!)).toBe('opencode auth login')
    expect(signInCommand(knownAgent('cursor')!)).toBe('cursor-agent login')
    expect(signInCommand(knownAgent('gemini')!)).toBeUndefined()
    expect(signInCommand(knownAgent('goose')!)).toBeUndefined()
  })

  it('can read the account of the two agents whose output is known, and no other', () => {
    expect(KNOWN_AGENTS.filter((entry) => entry.account).map((entry) => entry.id)).toEqual(['claude-code', 'codex'])
  })
})

describe('what adding an agent sets up', () => {
  it('talks to Claude Code itself, with or without Node.js', () => {
    expect(connectionFor(knownAgent('claude-code')!, true)).toEqual({ kind: 'acp', preset: 'claude-direct' })
    expect(connectionFor(knownAgent('claude-code')!, false)).toEqual({ kind: 'acp', preset: 'claude-direct' })
  })

  it('uses the ACP adapter for Codex when Node.js is there to run it, and has nothing better when it is not', () => {
    expect(connectionFor(knownAgent('codex')!, true)).toEqual({ kind: 'acp', preset: 'codex' })
    // Codex has no other way in, so the adapter stays and the page says Node.js is needed.
    expect(connectionFor(knownAgent('codex')!, false)).toEqual({ kind: 'acp', preset: 'codex' })
  })

  it('does not need Node.js for a program that speaks the protocol itself, or that Cubex starts directly', () => {
    expect(connectionNeedsNode(knownAgent('gemini')!.connection)).toBe(false)
    expect(connectionFor(knownAgent('gemini')!, false)).toEqual({ kind: 'acp', preset: 'gemini' })
    expect(connectionNeedsNode(knownAgent('claude-code')!.connection)).toBe(false)
    expect(connectionNeedsNode({ kind: 'acp', preset: 'claude' })).toBe(true)
    expect(connectionNeedsNode({ kind: 'cli', preset: 'claude-code' })).toBe(false)
  })
})

describe('which entry a saved agent belongs to', () => {
  it('knows the agents made from a preset', () => {
    expect(catalogIdOfPeer(newAcpPeer('claude-direct', []))).toBe('claude-code')
    // The adapter from npm and the one-shot command line are how Claude Code was set up before, and they still belong to it.
    expect(catalogIdOfPeer(newAcpPeer('claude', []))).toBe('claude-code')
    expect(catalogIdOfPeer(newAcpPeer('codex', []))).toBe('codex')
    expect(catalogIdOfPeer(newAcpPeer('gemini', []))).toBe('gemini')
    expect(catalogIdOfPeer(newCliPeer('claude-code', []))).toBe('claude-code')
    expect(catalogIdOfPeer(newCliPeer('antigravity', []))).toBe('antigravity')
  })

  it('puts the Antigravity runtime with the agy command line, and sets the runtime up when it is added', () => {
    expect(catalogIdOfPeer(newAcpPeer('agy-acp', []))).toBe('antigravity')
    expect(knownAgent('antigravity')?.connection).toEqual({ kind: 'acp', preset: 'agy-acp' })
  })

  it('knows a program saved by hand from the program it starts', () => {
    expect(catalogIdOfPeer(cli({ command: 'codex' }))).toBe('codex')
    expect(catalogIdOfPeer(cli({ command: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.cmd' }))).toBe('codex')
    expect(catalogIdOfPeer(cli({ command: '/usr/local/bin/CLAUDE' }))).toBe('claude-code')
    expect(catalogIdOfPeer(acp({ command: 'cursor-agent.exe' }))).toBe('cursor')
  })

  it('does not guess from a program that only contains the name', () => {
    expect(catalogIdOfPeer(cli({ command: 'codex-helper' }))).toBeUndefined()
    expect(catalogIdOfPeer(cli({ command: 'my-claude' }))).toBeUndefined()
    expect(catalogIdOfPeer(acp({ command: 'npx' }))).toBeUndefined()
  })

  it('has no entry for a model', () => {
    expect(catalogIdOfPeer({ kind: 'model', id: 'm', name: 'M', enabled: true, providerId: 'p', model: 'x' })).toBeUndefined()
  })
})

describe('the account in one line', () => {
  it('says who is signed in and with what', () => {
    expect(describeAccount({ state: 'signed-in', label: 'Claude subscription', email: 'ada@example.com' })).toBe('Signed in with Claude subscription (ada@example.com)')
    expect(describeAccount({ state: 'signed-in', label: 'ChatGPT account' })).toBe('Signed in with ChatGPT account')
    expect(describeAccount({ state: 'signed-in' })).toBe('Signed in')
  })

  it('says when nobody is, and when Cubex cannot tell', () => {
    expect(describeAccount({ state: 'signed-out' })).toBe('Not signed in')
    expect(describeAccount({ state: 'unknown' })).toBe('Sign-in not checked')
  })
})
