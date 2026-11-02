import { describe, expect, it } from 'vitest'
import { newAcpPeer, newCliPeer, type PeerConfig } from './peers'
import { catalogIdOfPeer } from './agentCatalog'

const acp = (over: Partial<PeerConfig> & { command: string; preset?: string }): PeerConfig =>
  ({ kind: 'acp', id: 'x', name: 'X', enabled: true, preset: 'custom', ...over }) as PeerConfig
const cli = (over: Partial<PeerConfig> & { command: string; preset?: string }): PeerConfig =>
  ({ kind: 'cli', id: 'x', name: 'X', enabled: true, preset: 'custom', ...over }) as PeerConfig

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

})
