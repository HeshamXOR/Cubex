import { createHash } from 'node:crypto'
import { REDACTED, redactString } from '@core/redaction'
import { envNameProblem, MCP_ENV_LIMITS, mcpSecretRef } from '@shared/policy'
import type { McpServerConfig } from '@shared/settings'

/** Reads the value kept under a credential reference, or undefined when nothing is kept there. */
export type SecretReader = (ref: string) => string | undefined

interface ResolvedMcpEnv {
  /** Plain variables and resolved secrets together: what is added to the server's environment. */
  env: Record<string, string>
  /** The values in `env` that are secrets, so everything the server prints can be scrubbed of them. */
  secretValues: string[]
  /** Secret variables whose value could not be read. */
  missing: string[]
}

type EnvSource = Pick<McpServerConfig, 'id' | 'env' | 'secretEnv'>

function readSafely(readSecret: SecretReader, ref: string): string | undefined {
  try {
    const value = readSecret(ref)
    return typeof value === 'string' && value !== '' ? value : undefined
  } catch {
    // A store that cannot be read is the same as a secret that is gone, and must not take a turn down.
    return undefined
  }
}

/** A saved value is only passed on when it is something a process can be started with. */
function usable(name: string, value: unknown): value is string {
  return envNameProblem(name) === undefined && typeof value === 'string' && value.length <= MCP_ENV_LIMITS.value && !value.includes('\0')
}

/**
 * The variables a saved server starts with. Settings are read from disk, so every entry is checked again
 * here. A secret is only read through the reference this server's id and the variable's name produce; any
 * other reference in settings counts as missing, so settings can never point a server at another credential.
 */
export function resolveMcpEnv(server: EnvSource, readSecret: SecretReader): ResolvedMcpEnv {
  const secretValues: string[] = []
  const missing: string[] = []
  const secrets: Record<string, string> = {}
  for (const [name, ref] of Object.entries(server.secretEnv ?? {})) {
    if (envNameProblem(name) !== undefined) continue
    const value = ref === mcpSecretRef(server.id, name) ? readSafely(readSecret, ref) : undefined
    if (value !== undefined && usable(name, value)) {
      secrets[name] = value
      secretValues.push(value)
    } else {
      missing.push(name)
    }
  }
  // A secret wins over a plain variable of the same name, and names are not told apart by case on Windows.
  const taken = new Set([...Object.keys(secrets), ...missing].map((name) => name.toLowerCase()))
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(server.env ?? {})) {
    if (usable(name, value) && !taken.has(name.toLowerCase())) env[name] = value
  }
  return { env: { ...env, ...secrets }, secretValues, missing }
}

/**
 * The environment a server is started with: the inherited one, already stripped of Cubex's own
 * credentials by `childEnvironment`, with the server's own variables on top. Those are an explicit
 * choice, so they are not filtered. On Windows names differ only by case, so one replaces the other.
 */
export function mergeChildEnvironment(base: NodeJS.ProcessEnv, own: Readonly<Record<string, string>>, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...base }
  for (const [name, value] of Object.entries(own)) {
    if (platform === 'win32') {
      const lower = name.toLowerCase()
      for (const key of Object.keys(merged)) if (key !== name && key.toLowerCase() === lower) delete merged[key]
    }
    merged[name] = value
  }
  return merged
}

/** A short value is too common in ordinary output to hide without wrecking the output around it. */
const MIN_SCRUBBED_CHARS = 4

export interface Scrubber {
  /** Scrub finished text: a tool result, an error, a line. */
  (text: string): string
  /** Scrub text that is still growing, such as the end of stderr: a value that has only begun to arrive is held back too. */
  growing: (text: string) => string
}

/** True when the end of `text`, `length` characters long, is the start of `needle`. Stops at the first difference, without building a string. */
function endsWithStartOf(text: string, needle: string, length: number): boolean {
  const start = text.length - length
  for (let i = 0; i < length; i++) if (text.charCodeAt(start + i) !== needle.charCodeAt(i)) return false
  return true
}

/** Scrubs text that is still growing: a value that has only begun to arrive at its end is held back too. */
function withoutPartialValue(clean: string, needles: readonly string[]): string {
  let held = 0
  for (const needle of needles) {
    for (let length = Math.min(needle.length - 1, clean.length); length > held && length >= MIN_SCRUBBED_CHARS; length--) {
      if (endsWithStartOf(clean, needle, length)) {
        held = length
        break
      }
    }
  }
  return held > 0 ? clean.slice(0, clean.length - held) : clean
}

/**
 * A function that removes the given secret values from text, and anything that looks like a known key
 * (the same pattern redaction the hook tests use). It also catches the forms a value takes when a program
 * prints it: escaped inside JSON and percent-encoded in a URL.
 */
export function makeScrubber(secretValues: readonly string[]): Scrubber {
  const needles = new Set<string>()
  for (const value of secretValues) {
    if (value.length < MIN_SCRUBBED_CHARS) continue
    needles.add(value)
    needles.add(JSON.stringify(value).slice(1, -1))
    needles.add(encodeURIComponent(value))
  }
  // Longest first, so a value that contains another one is hidden whole.
  const ordered = [...needles].sort((a, b) => b.length - a.length)
  const scrub = (text: string): string => {
    let clean = text
    for (const needle of ordered) clean = clean.split(needle).join(REDACTED)
    return redactString(clean)
  }
  return Object.assign(scrub, { growing: (text: string): string => withoutPartialValue(scrub(text), ordered) })
}

/** A fingerprint of an environment, so a changed value restarts a server without the value itself being kept in the comparison. */
export function envDigest(env: Readonly<Record<string, string>> | undefined): string {
  const pairs = Object.entries(env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return createHash('sha256').update(JSON.stringify(pairs)).digest('hex').slice(0, 16)
}
