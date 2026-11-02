import { spawn } from 'node:child_process'
import type { AcpPeer } from '@shared/peers'
import { LaunchError, resolveLaunch, type LaunchInput, type LaunchPlan } from '../../mcp/resolveLaunch'
import { startAntigravity } from '../antigravity/runtime'
import { launchProgram } from '../appPrograms'
import { startClaude } from '../claude/start'
import { peerEnvironment } from '../peerRunner'
import { AcpFailure } from './failure'
import type { AcpPolicy } from './permissions'
import { fromChild, type AcpProcess } from './process'

/**
 * How an agent's process is started. Most agents are a program that speaks the Agent Client Protocol and is started as it
 * is written in the list. Some need more: a bridge to a program that does not speak the protocol, or a program that needs
 * its own folders and variables. Each of those has a starter here, chosen by the agent's preset.
 */

export interface StartInput {
  peer: AcpPeer
  /** The folder the agent starts in. */
  cwd: string
  /** Where PATH and the variables to pass are read from. Defaults to this process's environment. */
  env: NodeJS.ProcessEnv | undefined
  /** What the agent may do. Its purpose decides which tools a bridge gives the program behind it. */
  policy: AcpPolicy | undefined
  signal: AbortSignal | undefined
  /** Replaces the lookup that decides how to start a program. For tests. */
  launch: ((input: LaunchInput) => LaunchPlan) | undefined
}

export type AcpStart = (input: StartInput) => AcpProcess | Promise<AcpProcess>

/** A program started as it is written in the list. */
export const spawnStart: AcpStart = (input) => {
  const { peer } = input
  const env = peerEnvironment(peer, input.env)
  let plan: LaunchPlan
  try {
    plan = launchProgram(input.launch ?? resolveLaunch, { command: peer.command, args: peer.args ?? [], cwd: input.cwd, env })
  } catch (error) {
    if (error instanceof LaunchError) throw new AcpFailure(error.message)
    throw new AcpFailure(error instanceof Error ? error.message : String(error))
  }
  try {
    return fromChild(spawn(plan.file, plan.args, {
      cwd: input.cwd,
      env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      // On POSIX the program leads its own group, so stopping it stops what it started too.
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    }))
  } catch (error) {
    throw new AcpFailure(`${peer.name} could not be started: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The starter for an agent. */
export function startFor(peer: AcpPeer): AcpStart {
  switch (peer.preset) {
    case 'claude-direct': return startClaude
    case 'agy-acp': return startAntigravity
    default: return spawnStart
  }
}
