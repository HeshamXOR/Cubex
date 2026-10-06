import { looksLikeSecretName, MCP_OUTPUT_LIMIT } from '@shared/policy'

/**
 * Turns what an MCP server's connection reported into something a person can act on: one sentence
 * saying what happened and, when the cause is recognizable, a second saying what to do. Pure, so
 * every message is covered by a table test. The text uses `backticks` for code; the page renders them.
 */

interface McpFailureInput {
  /** The raw message the client threw or recorded. */
  message: string
  /** The command as configured. */
  command: string
  /** The server's redacted stderr, when it printed any. */
  stderr?: string
  /** Names of the variables the server was started with, so a refused credential can be told from a missing one. */
  variables?: readonly string[]
  /** Secret variables with no saved value. The server was not started. */
  missingSecrets?: readonly string[]
}

interface McpFailureExplanation {
  error: string
  hint?: string
}

const NOT_FOUND = /^The command "[^"]*" was not found\./
const SPAWN_MISSING = /spawn \S+ ENOENT/
const NOT_STARTABLE = /^"([^"]*)" is not a program Windows can start directly/
const REINTERPRETED = /cmd\.exe would reinterpret/
const TIMED_OUT = /MCP "([^"]+)" timed out|MCP test timed out/
const EXITED = /MCP server "[^"]*" exited(?: with code (-?\d+)| \(([A-Z0-9]+)\))?/
const INPUT_CLOSED = /stopped reading its input/
const PROTOCOL = /Unsupported protocol version "([^"]*)"/
const RETRY_WINDOW = /failed recently; retry in (\d+)ms/
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

const NODE_PROGRAMS = new Set(['npx', 'npm', 'node', 'pnpm', 'pnpx', 'yarn', 'bunx', 'bun', 'deno'])

/** A variable name that holds a credential, as a server writes it in its output: SENTRY_ACCESS_TOKEN. */
const SECRET_VARIABLE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:KEY|TOKEN|SECRET|PASSWORD|PAT|CREDENTIALS?)\b/
const CREDENTIAL_REFUSED = /unauthori[sz]ed|forbidden|invalid (?:api )?(?:key|token)|bad credentials|authentication (?:failed|required)|missing (?:api )?(?:key|token)|\b40[13]\b/i
const VALUE_WANTED = /\b(?:required|missing|not set|unset|not defined|undefined|must be set|please set|is empty|not provided)\b/i

/** The server asked for a credential, or turned the one it got down. */
function needsCredential(stderr: string): boolean {
  if (CREDENTIAL_REFUSED.test(stderr)) return true
  return stderr.split('\n').some((line) => SECRET_VARIABLE.test(line) && VALUE_WANTED.test(line))
}

interface AdviceContext {
  stderr: string
  variables: readonly string[]
}

/** Points at the Environment variables field, and names the variable when the server did. */
function credentialAdvice({ stderr, variables }: AdviceContext): string {
  const where = 'under Environment variables for this server'
  const named = SECRET_VARIABLE.exec(stderr)?.[0]
  if (named && variables.some((variable) => variable.toUpperCase() === named.toUpperCase())) {
    return `The server did not accept the value of \`${named}\`. Replace it ${where}.`
  }
  if (named) return `The server wants \`${named}\`, which it did not get. Add it ${where} and turn on Secret.`
  if (variables.some(looksLikeSecretName)) return `The server did not accept the credential it was given. Check the values ${where}.`
  return `The server wants a credential it did not get. Add it ${where} and turn on Secret. Variables ending in _KEY, _TOKEN or _SECRET in your own environment are not passed on.`
}

/** What was in the server's output that points at a cause, most specific first. */
const OUTPUT_HINTS: ReadonlyArray<readonly [RegExp | ((stderr: string) => boolean), string | ((context: AdviceContext) => string)]> = [
  [/\bE404\b|npm error 404|404 Not Found/i, 'npm could not find that package. Check its name in Arguments.'],
  [/Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/i, 'The server is missing a package it needs. Reinstall it, or run the command in a terminal to see the whole error.'],
  [/ModuleNotFoundError|No module named/i, 'A Python package the server needs is not installed.'],
  [/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|network is unreachable/i, 'The server could not reach the network. Check the connection and any proxy.'],
  [/EADDRINUSE/i, 'The server tried to use a port that is already taken.'],
  [needsCredential, credentialAdvice],
  [/unknown (?:option|argument)|unrecognized (?:option|argument)|invalid (?:option|argument)|\busage:/i, 'The server did not accept its arguments. Check Arguments.'],
  [/EACCES|EPERM|permission denied|access is denied/i, 'The system denied access. Check file permissions and any security software.']
]

const BEFORE_TERMINAL = 'Run the same command in a terminal to see the whole error.'

function programOf(command: string): string {
  const base = command.trim().split(/[\\/]/).pop() ?? command
  return base.replace(/\.(?:cmd|exe|bat|com)$/i, '').toLowerCase()
}

function notFound(command: string): McpFailureExplanation {
  if (/[\\/]/.test(command)) {
    return { error: `No program was found at \`${command}\`.`, hint: 'Check the path in Command. On Windows, point at the .exe or .cmd file.' }
  }
  if (/\s/.test(command)) {
    return { error: `\`${command}\` is not the name of a program.`, hint: 'Command holds only the program. Put its options, such as -y and the package name, in Arguments.' }
  }
  const restart = 'If you just installed it, restart Cubex so it sees the new PATH.'
  if (NODE_PROGRAMS.has(programOf(command))) {
    return { error: `\`${command}\` was not found on PATH.`, hint: `Install Node.js, which includes npx and npm, or enter the full path to the program in Command. ${restart}` }
  }
  return { error: `\`${command}\` was not found on PATH.`, hint: `Install it, or enter the full path to the program in Command. ${restart}` }
}

function outputHint(stderr: string, variables: readonly string[]): string | undefined {
  for (const [matcher, advice] of OUTPUT_HINTS) {
    const matches = typeof matcher === 'function' ? matcher(stderr) : matcher.test(stderr)
    if (matches) return typeof advice === 'function' ? advice({ stderr, variables }) : advice
  }
  return undefined
}

function seconds(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))} s`
}

/** Variable names as a sentence needs them: `A`, `A` and `B`, `A`, `B` and `C`. */
function nameList(names: readonly string[]): string {
  const quoted = names.map((name) => `\`${name}\``)
  const last = quoted.pop()
  return quoted.length === 0 ? (last ?? '') : `${quoted.join(', ')} and ${last}`
}

/** The failure for a secret whose saved value cannot be read. It names each variable and says where to enter it again. */
export function missingSecretsMessage(names: readonly string[]): string {
  return names.length === 1
    ? `The saved value of ${nameList(names)} is no longer available. Enter it again in Settings.`
    : `The saved values of ${nameList(names)} are no longer available. Enter them again in Settings.`
}

/** One sentence for what went wrong and, when recognizable, one for the fix. */
export function describeMcpFailure(input: McpFailureInput): McpFailureExplanation {
  const message = input.message.replace(ANSI, '').trim()
  const command = input.command.trim()
  const stderr = input.stderr ?? ''
  const variables = input.variables ?? []

  if (input.missingSecrets && input.missingSecrets.length > 0) {
    return {
      error: missingSecretsMessage(input.missingSecrets),
      hint: `Open Environment variables on this server and enter ${input.missingSecrets.length === 1 ? 'the value' : 'each value'} again.`
    }
  }

  if (NOT_FOUND.test(message) || SPAWN_MISSING.test(message)) return notFound(command)

  const notStartable = NOT_STARTABLE.exec(message)
  if (notStartable) {
    return {
      error: `Windows cannot start \`${notStartable[1]}\` directly.`,
      hint: 'Use an interpreter such as node or python as the Command, and put the script path in Arguments.'
    }
  }
  if (REINTERPRETED.test(message)) {
    return { error: message, hint: 'Start the server with node or an .exe instead of a .cmd file, or change that value.' }
  }

  const protocol = PROTOCOL.exec(message)
  if (protocol) {
    return { error: `The server speaks MCP protocol ${protocol[1]}, which Cubex does not support.`, hint: 'Update the server to a current version.' }
  }

  const retry = RETRY_WINDOW.exec(message)
  if (retry) {
    return { error: 'Cubex stopped retrying for a moment after repeated failures.', hint: `It tries again in ${seconds(Number(retry[1]))}, or when the next session starts.` }
  }

  const timedOut = TIMED_OUT.exec(message)
  if (timedOut) {
    const method = timedOut[1]
    const cause = outputHint(stderr, variables)
    if (method === 'tools/list') {
      return { error: 'The server started but did not list its tools in time.', hint: cause ?? 'Try again. If it keeps happening, the server is stuck: read its output.' }
    }
    return {
      error: 'The server did not answer the MCP handshake in time.',
      hint: cause ?? 'Check that the command starts an MCP server that talks over stdio. A package that is still downloading on its first run can be slow, so try again. Servers that only speak HTTP are not supported.'
    }
  }

  const exited = EXITED.exec(message)
  if (exited) {
    const detail = exited[1] !== undefined ? ` (code ${exited[1]})` : exited[2] ? ` (${exited[2]})` : ''
    return { error: `The server exited${detail}.`, hint: outputHint(stderr, variables) ?? (stderr.trim() ? 'Read its output for the reason.' : BEFORE_TERMINAL) }
  }

  if (INPUT_CLOSED.test(message)) {
    return { error: 'The server stopped reading its input, so it has probably exited.', hint: outputHint(stderr, variables) ?? BEFORE_TERMINAL }
  }

  const cause = outputHint(stderr, variables)
  return { error: message.length > 400 ? `${message.slice(0, 399)}…` : message || 'The server could not be reached.', hint: cause ?? (stderr.trim() ? 'Read its output for the reason.' : BEFORE_TERMINAL) }
}

/** The tail of a server's stderr as shown to the person: no color codes, at most MCP_OUTPUT_LIMIT characters, from a whole line. */
export function cleanServerOutput(stderr: string | undefined): string | undefined {
  const text = (stderr ?? '').replace(ANSI, '').replace(/\r\n?/g, '\n').trim()
  if (!text) return undefined
  if (text.length <= MCP_OUTPUT_LIMIT) return text
  const tail = text.slice(-MCP_OUTPUT_LIMIT)
  const firstBreak = tail.indexOf('\n')
  return `…\n${firstBreak >= 0 && firstBreak < 400 ? tail.slice(firstBreak + 1) : tail}`
}
