import { describe, expect, it } from 'vitest'
import { describeMcpFailure } from './mcpDiagnose'

const notFound = (command: string): string => `The command "${command}" was not found. Install it, add it to PATH, or give the full path to the program.`

describe('describeMcpFailure', () => {
  it('names the program that is missing, and says how to get it', () => {
    expect(describeMcpFailure({ message: notFound('npx'), command: 'npx' })).toEqual({
      error: '`npx` was not found on PATH.',
      hint: 'Install Node.js, which includes npx and npm, or enter the full path to the program in Command. If you just installed it, restart Cubex so it sees the new PATH.'
    })
    expect(describeMcpFailure({ message: notFound('uvx'), command: 'uvx' })).toEqual({
      error: '`uvx` was not found on PATH.',
      hint: 'Install it, or enter the full path to the program in Command. If you just installed it, restart Cubex so it sees the new PATH.'
    })
  })

  it('explains a file Windows cannot run directly', () => {
    const message = '"C:\\x\\server.js" is not a program Windows can start directly. Use an interpreter such as node or python as the command and pass the script as an argument.'
    expect(describeMcpFailure({ message, command: 'C:\\x\\server.js' })).toEqual({
      error: 'Windows cannot start `C:\\x\\server.js` directly.',
      hint: 'Use an interpreter such as node or python as the Command, and put the script path in Arguments.'
    })
  })

  it('reports an exit with its code or signal', () => {
    expect(describeMcpFailure({ message: 'MCP server "Files" exited with code 1', command: 'x' }).error).toBe('The server exited (code 1).')
    expect(describeMcpFailure({ message: 'MCP server "Files" exited (SIGKILL)', command: 'x' }).error).toBe('The server exited (SIGKILL).')
    expect(describeMcpFailure({ message: 'MCP server "Files" exited', command: 'x' }).error).toBe('The server exited.')
  })

  describe('a server that needs a token', () => {
    const exited = 'MCP server "Sentry" exited with code 1'
    const asked = 'Error: SENTRY_ACCESS_TOKEN is required. Create a token at sentry.io and set it in the environment.'

    it('points at the Environment variables field and names the variable the server asked for', () => {
      expect(describeMcpFailure({ message: exited, command: 'npx', stderr: asked, variables: ['SENTRY_ORG'] }).hint)
        .toBe('The server wants `SENTRY_ACCESS_TOKEN`, which it did not get. Add it under Environment variables for this server and turn on Secret.')
    })
  })

  describe('a secret whose saved value is gone', () => {
    it('names the variable, says to enter it again in Settings, and says where', () => {
      expect(describeMcpFailure({ message: '', command: 'npx', missingSecrets: ['SENTRY_ACCESS_TOKEN'] })).toEqual({
        error: 'The saved value of `SENTRY_ACCESS_TOKEN` is no longer available. Enter it again in Settings.',
        hint: 'Open Environment variables on this server and enter the value again.'
      })
    })
  })
})
