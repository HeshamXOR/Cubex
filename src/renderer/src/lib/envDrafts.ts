import {
  duplicateEnvNames, envNameProblem, looksLikeSecretName, MCP_ENV_LIMITS, mcpSecretRef
} from '../../../shared/policy'
import type { McpServerConfig } from '../../../shared/settings'

/**
 * The environment variables of an MCP server while they are being edited. The editor works on drafts and
 * only changes anything when it is saved, so half-typed rows never reach settings or the credential store.
 * A secret that is already saved is never read back: its draft says only that a value exists.
 */

export interface EnvDraft {
  /** Identity of the row while editing. Not saved. */
  key: string
  name: string
  secret: boolean
  /** What was typed. Empty for a saved secret that is being kept. */
  value: string
  /** A secret of this name is stored and will be kept unless the person chooses Replace. */
  saved: boolean
  /** Settings list this secret, but its stored value is gone. */
  lost: boolean
  /** The person chose Replace and is typing a new value. */
  replacing: boolean
}

export interface EnvRowProblems {
  name?: string
  value?: string
}

export interface EnvCheck {
  /** Problems by row key. Only rows that have one are present. */
  rows: ReadonlyMap<string, EnvRowProblems>
  /** A problem with the variables as a whole. */
  overall?: string
  ok: boolean
}

let counter = 0
const nextKey = (): string => `env-${++counter}`

/** An empty row for a variable that has not been named yet. */
export function blankDraft(secret = false): EnvDraft {
  return { key: nextKey(), name: '', secret, value: '', saved: false, lost: false, replacing: false }
}

/** The rows of a saved server: its plain variables first, then its secrets with what is known about their stored values. */
export function draftsFromServer(server: Pick<McpServerConfig, 'env' | 'secretEnv'> | undefined, missing: readonly string[] = []): EnvDraft[] {
  const plain = Object.entries(server?.env ?? {}).map(([name, value]): EnvDraft => ({ ...blankDraft(false), name, value }))
  const secrets = Object.keys(server?.secretEnv ?? {}).map((name): EnvDraft => {
    const lost = missing.includes(name)
    return { ...blankDraft(true), name, saved: !lost, lost }
  })
  return [...plain, ...secrets]
}

/** A row nothing has been typed into. It is left out when saving instead of being an error. */
const isBlank = (draft: EnvDraft): boolean => draft.name === '' && draft.value === '' && !draft.saved && !draft.lost

/**
 * Check the rows. A name must be valid and used once (case does not count, as on Windows), a secret needs
 * a value unless a saved one is kept, and the whole set stays within what a process can be started with.
 * Missing names and values are only reported once `complete` is set, so a row being typed is not scolded.
 */
export function checkDrafts(drafts: readonly EnvDraft[], complete: boolean): EnvCheck {
  const rows = new Map<string, EnvRowProblems>()
  const flag = (key: string, field: keyof EnvRowProblems, message: string): void => {
    const current = rows.get(key) ?? {}
    rows.set(key, field === 'name' ? { ...current, name: message } : { ...current, value: message })
  }
  const used = drafts.filter((draft) => !isBlank(draft))
  const repeated = duplicateEnvNames(used.map((draft) => draft.name).filter(Boolean))
  const repeatedLower = new Set([...repeated].map((name) => name.toLowerCase()))
  for (const draft of used) {
    if (draft.name === '') {
      if (complete) flag(draft.key, 'name', 'Enter a name.')
    } else {
      const problem = envNameProblem(draft.name)
      if (problem) flag(draft.key, 'name', problem)
      else if (repeatedLower.has(draft.name.toLowerCase())) flag(draft.key, 'name', 'Another variable already uses this name. Case does not count.')
    }
    if (draft.value.length > MCP_ENV_LIMITS.value) {
      flag(draft.key, 'value', `Use ${MCP_ENV_LIMITS.value.toLocaleString('en-US')} characters or fewer.`)
    } else if (complete && draft.secret && draft.value === '' && !(draft.saved && !draft.replacing)) {
      flag(draft.key, 'value', 'Enter the secret.')
    }
  }
  let overall: string | undefined
  if (used.length > MCP_ENV_LIMITS.variables) {
    overall = `Use ${MCP_ENV_LIMITS.variables} variables or fewer.`
  } else if (used.reduce((sum, draft) => sum + draft.name.length + draft.value.length, 0) > MCP_ENV_LIMITS.totalChars) {
    overall = `Variables must total ${MCP_ENV_LIMITS.totalChars.toLocaleString('en-US')} characters or fewer.`
  }
  return { rows, ...(overall ? { overall } : {}), ok: rows.size === 0 && overall === undefined }
}

/** True for a plain variable named like a credential, which should probably be a secret. Advice, not an error. */
export function shouldBeSecret(draft: EnvDraft): boolean {
  return !draft.secret && looksLikeSecretName(draft.name)
}

/** The row after the Secret switch is turned. A stored value cannot be carried over to a plain variable, nor read back into a plain field. */
export function toggleSecret(draft: EnvDraft): EnvDraft {
  return draft.secret
    ? { ...draft, secret: false, value: '', saved: false, lost: false, replacing: false }
    : { ...draft, secret: true }
}

export interface EnvChange {
  env?: Record<string, string>
  secretEnv?: Record<string, string>
  /** Secret values to put in the credential store: new secrets, replacements and ones that were lost. */
  toSave: Array<{ name: string; value: string }>
  /** Secrets that were stored for this server and are no longer used: removed, made plain, or renamed. */
  toForget: string[]
}

/**
 * What saving the rows changes. `stored` names the secrets that are stored for the server now, so one that
 * disappears from the rows is deleted from the credential store instead of being left behind.
 */
export function planEnvChange(drafts: readonly EnvDraft[], stored: readonly string[], serverId: string): EnvChange {
  const env: Record<string, string> = {}
  const secretEnv: Record<string, string> = {}
  const toSave: EnvChange['toSave'] = []
  for (const draft of drafts) {
    if (isBlank(draft)) continue
    if (!draft.secret) {
      env[draft.name] = draft.value
      continue
    }
    secretEnv[draft.name] = mcpSecretRef(serverId, draft.name)
    if (draft.value !== '') toSave.push({ name: draft.name, value: draft.value })
  }
  const kept = new Set(Object.keys(secretEnv))
  return {
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(kept.size > 0 ? { secretEnv } : {}),
    toSave,
    toForget: stored.filter((name) => !kept.has(name))
  }
}

/** The variables of a connection test of unsaved rows: plain ones, secrets typed in, and the names of saved ones the server's id can read. */
export function testVariables(drafts: readonly EnvDraft[]): { env?: Record<string, string>; secrets?: Record<string, string>; savedSecrets?: string[] } {
  const env: Record<string, string> = {}
  const secrets: Record<string, string> = {}
  const savedSecrets: string[] = []
  for (const draft of drafts) {
    if (isBlank(draft) || draft.name === '') continue
    if (!draft.secret) env[draft.name] = draft.value
    else if (draft.value !== '') secrets[draft.name] = draft.value
    else if (draft.saved && !draft.replacing) savedSecrets.push(draft.name)
  }
  return {
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
    ...(savedSecrets.length > 0 ? { savedSecrets } : {})
  }
}

/** Variables a saved server has, for its row and for tests of the saved configuration. */
export function savedVariables(server: Pick<McpServerConfig, 'env' | 'secretEnv'>): { env?: Record<string, string>; savedSecrets?: string[] } {
  const names = Object.keys(server.secretEnv ?? {})
  return {
    ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
    ...(names.length > 0 ? { savedSecrets: names } : {})
  }
}

/** Whether two sets of variables are the same. No set and an empty one count as equal. */
export function sameVariables(a: Readonly<Record<string, string>> | undefined, b: Readonly<Record<string, string>> | undefined): boolean {
  const left = Object.entries(a ?? {})
  const right = b ?? {}
  return left.length === Object.keys(right).length && left.every(([name, value]) => Object.prototype.hasOwnProperty.call(right, name) && right[name] === value)
}
