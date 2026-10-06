import { describe, expect, it } from 'vitest'
import { MCP_OUTPUT_LIMIT } from '@shared/policy'
import { cleanServerOutput, describeMcpFailure, missingSecretsMessage } from './mcpDiagnose'

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

  it('recognizes a missing program on other platforms too', () => {
    expect(describeMcpFailure({ message: 'MCP server "Files" failed to start: spawn npx ENOENT', command: 'npx' }).error).toBe('`npx` was not found on PATH.')
  })

  it('tells a path from a program name', () => {
    expect(describeMcpFailure({ message: notFound('C:\\tools\\server.exe'), command: 'C:\\tools\\server.exe' })).toEqual({
      error: 'No program was found at `C:\\tools\\server.exe`.',
      hint: 'Check the path in Command. On Windows, point at the .exe or .cmd file.'
    })
  })

  it('catches a command line typed into Command', () => {
    const explained = describeMcpFailure({ message: notFound('npx -y some-server'), command: 'npx -y some-server' })
    expect(explained.error).toBe('`npx -y some-server` is not the name of a program.')
    expect(explained.hint).toContain('Put its options')
  })

  it('explains a file Windows cannot run directly', () => {
    const message = '"C:\\x\\server.js" is not a program Windows can start directly. Use an interpreter such as node or python as the command and pass the script as an argument.'
    expect(describeMcpFailure({ message, command: 'C:\\x\\server.js' })).toEqual({
      error: 'Windows cannot start `C:\\x\\server.js` directly.',
      hint: 'Use an interpreter such as node or python as the Command, and put the script path in Arguments.'
    })
  })

  it('keeps the launcher message when cmd.exe would rewrite an argument', () => {
    const message = 'The argument 2 contains a quote, percent sign or line break, which cmd.exe would reinterpret. Start the server with node or an .exe instead of a .cmd file, or change that value.'
    expect(describeMcpFailure({ message, command: 'x.cmd' }).error).toBe(message)
  })

  it('reads a handshake that never finished', () => {
    const explained = describeMcpFailure({ message: 'MCP "initialize" timed out', command: 'npx' })
    expect(explained.error).toBe('The server did not answer the MCP handshake in time.')
    expect(explained.hint).toContain('talks over stdio')
    expect(describeMcpFailure({ message: 'MCP test timed out', command: 'npx' }).error).toBe('The server did not answer the MCP handshake in time.')
  })

  it('reads a tool list that never arrived', () => {
    expect(describeMcpFailure({ message: 'MCP "tools/list" timed out', command: 'x' }).error).toBe('The server started but did not list its tools in time.')
  })

  it('reports an exit with its code or signal', () => {
    expect(describeMcpFailure({ message: 'MCP server "Files" exited with code 1', command: 'x' }).error).toBe('The server exited (code 1).')
    expect(describeMcpFailure({ message: 'MCP server "Files" exited (SIGKILL)', command: 'x' }).error).toBe('The server exited (SIGKILL).')
    expect(describeMcpFailure({ message: 'MCP server "Files" exited', command: 'x' }).error).toBe('The server exited.')
  })

  it('points at the terminal when the server said nothing', () => {
    expect(describeMcpFailure({ message: 'MCP server "Files" exited with code 1', command: 'x' }).hint).toBe('Run the same command in a terminal to see the whole error.')
  })

  it('sends the person to the output when there is one but no known cause', () => {
    expect(describeMcpFailure({ message: 'MCP server "Files" exited with code 1', command: 'x', stderr: 'something odd happened' }).hint).toBe('Read its output for the reason.')
  })

  it.each([
    ['npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@x%2fnope', 'npm could not find that package. Check its name in Arguments.'],
    ["Error: Cannot find module 'zod'", 'The server is missing a package it needs. Reinstall it, or run the command in a terminal to see the whole error.'],
    ["ModuleNotFoundError: No module named 'mcp'", 'A Python package the server needs is not installed.'],
    ['getaddrinfo ENOTFOUND api.example.com', 'The server could not reach the network. Check the connection and any proxy.'],
    ['Error: listen EADDRINUSE: address already in use :::3000', 'The server tried to use a port that is already taken.'],
    ['401 Unauthorized', 'The server wants a credential it did not get. Add it under Environment variables for this server and turn on Secret. Variables ending in _KEY, _TOKEN or _SECRET in your own environment are not passed on.'],
    ['error: unknown option --stdioo', 'The server did not accept its arguments. Check Arguments.'],
    ['EACCES: permission denied', 'The system denied access. Check file permissions and any security software.']
  ])('recognizes a cause in the output: %j', (stderr, hint) => {
    expect(describeMcpFailure({ message: 'MCP server "Files" exited with code 1', command: 'npx', stderr }).hint).toBe(hint)
  })

  it('uses the cause in the output for a timeout as well', () => {
    expect(describeMcpFailure({ message: 'MCP "initialize" timed out', command: 'npx', stderr: 'npm error code E404' }).hint).toBe('npm could not find that package. Check its name in Arguments.')
  })

  describe('a server that needs a token', () => {
    const exited = 'MCP server "Sentry" exited with code 1'
    const asked = 'Error: SENTRY_ACCESS_TOKEN is required. Create a token at sentry.io and set it in the environment.'

    it('points at the Environment variables field and names the variable the server asked for', () => {
      expect(describeMcpFailure({ message: exited, command: 'npx', stderr: asked, variables: ['SENTRY_ORG'] }).hint)
        .toBe('The server wants `SENTRY_ACCESS_TOKEN`, which it did not get. Add it under Environment variables for this server and turn on Secret.')
    })

    it('recognizes the common ways a server says it wants a variable', () => {
      for (const stderr of [
        'Missing required environment variable: GITHUB_TOKEN',
        'Please set OPENAI_API_KEY before starting',
        'error: API_KEY environment variable not set',
        'DATABASE_PASSWORD is not defined'
      ]) {
        expect(describeMcpFailure({ message: exited, command: 'npx', stderr }).hint).toContain('Environment variables')
      }
    })

    it('says the value was refused, not missing, when the variable was already given', () => {
      expect(describeMcpFailure({ message: exited, command: 'npx', stderr: 'SENTRY_ACCESS_TOKEN rejected: 401 Unauthorized', variables: ['sentry_access_token'] }).hint)
        .toBe('The server did not accept the value of `SENTRY_ACCESS_TOKEN`. Replace it under Environment variables for this server.')
    })

    it('says the credential was refused when it was given under a name the server did not print', () => {
      expect(describeMcpFailure({ message: exited, command: 'npx', stderr: '403 Forbidden', variables: ['MY_SERVICE_TOKEN'] }).hint)
        .toBe('The server did not accept the credential it was given. Check the values under Environment variables for this server.')
    })

    it('does not call a refusal a missing credential when the variables given hold none', () => {
      expect(describeMcpFailure({ message: exited, command: 'npx', stderr: '401 Unauthorized', variables: ['REGION'] }).hint).toContain('wants a credential it did not get')
    })

    it('leaves other output alone', () => {
      expect(describeMcpFailure({ message: exited, command: 'npx', stderr: 'REGION is required' }).hint).toBe('Read its output for the reason.')
    })
  })

  describe('a secret whose saved value is gone', () => {
    it('names the variable, says to enter it again in Settings, and says where', () => {
      expect(describeMcpFailure({ message: '', command: 'npx', missingSecrets: ['SENTRY_ACCESS_TOKEN'] })).toEqual({
        error: 'The saved value of `SENTRY_ACCESS_TOKEN` is no longer available. Enter it again in Settings.',
        hint: 'Open Environment variables on this server and enter the value again.'
      })
    })

    it('names each variable when several are gone', () => {
      expect(describeMcpFailure({ message: '', command: 'npx', missingSecrets: ['A_TOKEN', 'B_TOKEN'] })).toEqual({
        error: 'The saved values of `A_TOKEN` and `B_TOKEN` are no longer available. Enter them again in Settings.',
        hint: 'Open Environment variables on this server and enter each value again.'
      })
      expect(missingSecretsMessage(['A', 'B', 'C'])).toBe('The saved values of `A`, `B` and `C` are no longer available. Enter them again in Settings.')
    })

    it('is a sentence, never a stack trace, and wins over whatever else was recorded', () => {
      const explained = describeMcpFailure({ message: 'Error: boom\n    at start (McpClient.ts:1:1)', command: 'npx', missingSecrets: ['X_TOKEN'] })
      expect(explained.error).not.toMatch(/\bat \w+ \(|Error:/)
    })
  })

  it('reads an unsupported protocol version', () => {
    expect(describeMcpFailure({ message: 'Unsupported protocol version "1999-01-01"', command: 'x' })).toEqual({
      error: 'The server speaks MCP protocol 1999-01-01, which Cubex does not support.',
      hint: 'Update the server to a current version.'
    })
  })

  it('reads the pause after repeated failures', () => {
    expect(describeMcpFailure({ message: 'MCP connection failed recently; retry in 12000ms', command: 'x' })).toEqual({
      error: 'Cubex stopped retrying for a moment after repeated failures.',
      hint: 'It tries again in 12 s, or when the next session starts.'
    })
  })

  it('reads a broken input pipe', () => {
    const explained = describeMcpFailure({ message: 'MCP server "Files" stopped reading its input (EPIPE); it has probably exited', command: 'x' })
    expect(explained.error).toBe('The server stopped reading its input, so it has probably exited.')
  })

  it('passes an unknown message through, bounded, with the generic next step', () => {
    expect(describeMcpFailure({ message: 'something new', command: 'x' })).toEqual({ error: 'something new', hint: 'Run the same command in a terminal to see the whole error.' })
    const long = describeMcpFailure({ message: 'x'.repeat(1_000), command: 'x' }).error
    expect(long).toHaveLength(400)
    expect(long.endsWith('…')).toBe(true)
    expect(describeMcpFailure({ message: '', command: 'x' }).error).toBe('The server could not be reached.')
  })
})

describe('cleanServerOutput', () => {
  it('returns nothing for silence', () => {
    expect(cleanServerOutput(undefined)).toBeUndefined()
    expect(cleanServerOutput('  \n ')).toBeUndefined()
  })

  it('strips color codes and normalizes line breaks', () => {
    expect(cleanServerOutput('\u001b[31merror\u001b[0m: bad\r\nnext\r')).toBe('error: bad\nnext')
  })

  it('keeps the end of a long output, from a whole line', () => {
    const lines = Array.from({ length: 2_000 }, (_, i) => `line ${i}`).join('\n')
    const cleaned = cleanServerOutput(lines)!
    expect(cleaned.length).toBeLessThanOrEqual(MCP_OUTPUT_LIMIT + 2)
    expect(cleaned.startsWith('…\nline ')).toBe(true)
    expect(cleaned.endsWith('line 1999')).toBe(true)
  })
})
