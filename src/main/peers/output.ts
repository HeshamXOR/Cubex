import { redactString } from '@core/redaction'
import type { PeerOutputFormat, PeerVerdict } from '@shared/peers'

/** Everything a program prints is bounded before it is kept, shown or sent on. */
export const PEER_STDOUT_CAP = 400_000
export const PEER_STDERR_TAIL = 8_000
/** What the model gets back from one message. A longer answer is cut, and says so. */
export const PEER_REPLY_CAP = 24_000

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

/** Text from a program, ready to read: no colour codes, one kind of line break, no secrets that look like keys. */
export function cleanOutput(text: string): string {
  return redactString(stripAnsi(text).replace(/\r\n?/g, '\n')).trim()
}

/** The end of long output, which is where a program says why it stopped. */
export function tail(text: string, limit: number): string {
  return text.length <= limit ? text : `…${text.slice(text.length - limit + 1)}`
}

/** The start of long text, with a note that it was cut. */
export function clipReply(text: string, limit = PEER_REPLY_CAP): string {
  if (text.length <= limit) return text
  let cut = text.slice(0, limit)
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return `${cut}\n[The reply was longer than ${limit.toLocaleString('en-US')} characters and was shortened.]`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export interface ParsedOutput {
  /** What the agent said. Empty when it said nothing. */
  reply: string
  /** The program reported a failure of its own, in its output. */
  error?: string
}

/** The last object of a list of events that says it is the result, or the last object at all. */
function pick(parsed: unknown): Record<string, unknown> | undefined {
  if (isRecord(parsed)) return parsed
  if (!Array.isArray(parsed)) return undefined
  const objects = parsed.filter(isRecord)
  return [...objects].reverse().find((entry) => entry.type === 'result') ?? objects[objects.length - 1]
}

function tryJson(raw: string): unknown {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  try { return JSON.parse(trimmed) as unknown } catch { return undefined }
}

/**
 * Read what a program printed. The presets print one JSON object, but a new version, a warning line in front of it
 * or an error before it should not turn a reply into nothing: anything that is not the shape expected is read as text.
 */
export function parsePeerOutput(format: PeerOutputFormat, stdout: string): ParsedOutput {
  const raw = stdout.replace(/\r\n?/g, '\n')
  if (format === 'text') return { reply: cleanOutput(raw) }

  let json = tryJson(raw)
  if (json === undefined) {
    // A line or two of warnings may come before the object: look for it from the first line that starts one.
    const start = raw.search(/^[{[]/m)
    if (start > 0) json = tryJson(raw.slice(start))
  }
  const entry = pick(json)
  if (!entry) return { reply: cleanOutput(raw) }

  if (format === 'claude-json') {
    const reply = text(entry.result)
    if (reply === undefined) {
      const subtype = text(entry.subtype)
      if (entry.is_error === true || subtype?.startsWith('error')) return { reply: '', error: `Claude Code stopped before it replied (${subtype ?? 'error'}).` }
      return { reply: cleanOutput(raw) }
    }
    return { reply: cleanOutput(reply), ...(entry.is_error === true ? { error: cleanOutput(reply) || 'Claude Code reported an error.' } : {}) }
  }

  // Antigravity: { response, status, error, ... }.
  const reply = text(entry.response) ?? text(entry.result) ?? text(entry.text) ?? text(entry.output)
  const failure = isRecord(entry.error) ? text(entry.error.message) : text(entry.error)
  if (reply === undefined && failure === undefined) return { reply: cleanOutput(raw) }
  return { reply: cleanOutput(reply ?? ''), ...(failure ? { error: cleanOutput(failure) } : {}) }
}

const VERDICT = /^\s*[*_`>#-]*\s*verdict\s*[:\-–]\s*[*_`]*\s*(agree|partly agree|partially agree|disagree|strongly disagree)\b[^\n]*$/i

/**
 * The verdict an agent was asked to end with, and the reply without that line. Only the last non-empty line counts,
 * so a sentence in the middle that mentions a verdict is not mistaken for one.
 */
export function splitVerdict(reply: string): { body: string; verdict?: PeerVerdict } {
  const lines = reply.split('\n')
  let index = lines.length - 1
  while (index >= 0 && lines[index]!.trim() === '') index--
  const match = index >= 0 ? VERDICT.exec(lines[index]!) : null
  if (!match) return { body: reply.trim() }
  const word = match[1]!.toLowerCase()
  const verdict: PeerVerdict = word === 'agree' ? 'agree' : word.endsWith('disagree') ? 'disagree' : 'partly'
  return { body: lines.slice(0, index).join('\n').trim(), verdict }
}

/** Keeps another agent's words from closing the wrapper they are returned in. */
export function escapeReply(reply: string): string {
  return reply.replace(/<(\/?)agent_reply/gi, '<\u200b$1agent_reply')
}

/** What to try, from how a program failed. Matched on its own words, which differ between versions, so a miss is just no hint. */
export function failureHint(output: string, exitCode: number | null | undefined): string | undefined {
  const lowered = output.toLowerCase()
  if (/not logged in|please run \/login|\/login|invalid api key|authentication|unauthori[sz]ed|401|sign in|log in to continue|api key.*(missing|not set|required)/.test(lowered)) {
    return 'Sign in to the program first: start it once in a terminal and follow its login steps. If it uses an API key from your environment, add that variable under "Variables to pass".'
  }
  if (/credit balance|quota|rate limit|too many requests|429|billing|insufficient/.test(lowered)) {
    return 'The program\'s own account is out of credit or over its limit. Check that account, then try again.'
  }
  if (/unknown (option|argument|flag)|unrecognized (option|argument)|invalid option|no such option|did you mean/.test(lowered)) {
    return 'This version of the program does not accept an option Cubex passes. Update the program, or add it as another program with the arguments your version takes.'
  }
  if (exitCode === 127) return 'The program could not be started. Check that it is installed and that its name or path is right.'
  return undefined
}
