import { spawn } from 'node:child_process'
import type { AcpPeer } from '@shared/peers'
import { resolveLaunch, type LaunchPlan } from '../../mcp/resolveLaunch'
import { AcpFailure } from '../acp/failure'
import { fromChild } from '../acp/process'
import type { AcpStart, StartInput } from '../acp/starters'
import { launchProgram, type AppHost } from '../appPrograms'
import { peerEnvironment } from '../peerRunner'
import { ClaudeBridge } from './bridge'
import { claudeArguments, claudeEnvironment, modelFrom, writeSettingsFile } from './launch'

/**
 * Starts Claude Code for an agent of the preset "claude-direct": the program the person has on PATH, or else the copy the
 * Claude desktop app keeps for itself, started in its stream-json mode and wrapped in a bridge that speaks the Agent Client
 * Protocol. The copy a desktop app keeps changes with each update and its folder is named for the version, so it is looked for
 * again each time and never saved.
 */

const NOT_FOUND_HINT = 'Install Claude Code, or install the Claude desktop app, which comes with it. If it is installed in a folder that is not on PATH, give its full path under Edit.'

/** The way to start the program: the one the agent is set to, and failing that the copy in the Claude desktop app. */
export function planFor(peer: AcpPeer, input: StartInput, env: NodeJS.ProcessEnv, args: string[], host?: AppHost): LaunchPlan {
  try {
    return launchProgram(input.launch ?? resolveLaunch, { command: peer.command, args, cwd: input.cwd, env }, host)
  } catch (error) {
    throw new AcpFailure(error instanceof Error ? error.message : String(error), { hint: NOT_FOUND_HINT })
  }
}

export const startClaude: AcpStart = (input) => {
  const { peer } = input
  const env = claudeEnvironment(peerEnvironment(peer, input.env))
  const purpose = input.policy?.purpose ?? 'consult'
  let settings: ReturnType<typeof writeSettingsFile>
  try {
    settings = writeSettingsFile()
  } catch (error) {
    throw new AcpFailure(`${peer.name} could not be started: the file with the rules it is held to could not be written (${error instanceof Error ? error.message : String(error)}).`, {
      hint: 'Check that the temporary folder exists and has room, then try again.'
    })
  }
  try {
    const plan = planFor(peer, input, env, claudeArguments({ purpose, settingsFile: settings.file, model: modelFrom(peer.args) }))
    const child = spawn(plan.file, plan.args, {
      cwd: input.cwd,
      env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      // On POSIX the program leads its own group, so stopping it stops what it started too.
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe']
    })
    return new ClaudeBridge({ claude: fromChild(child), cwd: input.cwd, name: peer.name, cleanup: settings.remove }).process
  } catch (error) {
    settings.remove()
    if (error instanceof AcpFailure) throw error
    throw new AcpFailure(`${peer.name} could not be started: ${error instanceof Error ? error.message : String(error)}`)
  }
}
