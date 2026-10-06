/**
 * The prompts a person has sent, per project, kept on this computer so Up Arrow in the composer can bring
 * them back. Nothing here leaves the machine, and nothing is sent to a model.
 */

export interface PromptStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** The browser storage entry that holds every project's prompts. A `storage` event for it means another window changed them. */
export const HISTORY_STORAGE_KEY = 'cubex.promptHistory.v1'
const STORAGE_KEY = HISTORY_STORAGE_KEY
/** Prompts remembered per project; the oldest fall away first. */
export const HISTORY_PER_PROJECT = 100
/** A longer prompt is a pasted document, not something to recall with an arrow key, so it is not kept. */
export const HISTORY_ENTRY_MAX_CHARS = 4000
export const HISTORY_PROJECTS = 24
/** Browser storage is a few megabytes for everything the app keeps; history stays well inside that. */
const HISTORY_MAX_CHARS = 1_000_000

interface ProjectHistory {
  updatedAt: number
  /** Oldest first. */
  prompts: string[]
}

type Everything = Record<string, ProjectHistory>

/** The key a project's history is filed under. Windows paths ignore case and slash direction. */
export function projectKey(workspacePath: string | undefined): string {
  const path = workspacePath?.trim().replace(/[\\/]+$/, '') ?? ''
  if (!path) return ''
  return /^[a-z]:/i.test(path) || path.includes('\\') ? path.toLowerCase().replace(/\\/g, '/') : path
}

function read(storage: PromptStorage): Everything {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const everything: Everything = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as Partial<ProjectHistory> | null
      if (!entry || !Array.isArray(entry.prompts)) continue
      const prompts = entry.prompts.filter((prompt): prompt is string => typeof prompt === 'string')
      if (prompts.length) everything[key] = { updatedAt: Number(entry.updatedAt) || 0, prompts }
    }
    return everything
  } catch {
    return {}
  }
}

/** Keep the newest projects and the newest prompts, and the whole of it inside a size that storage will take. */
function trim(everything: Everything): Everything {
  const newestFirst = Object.entries(everything).sort(([, a], [, b]) => b.updatedAt - a.updatedAt).slice(0, HISTORY_PROJECTS)
  const kept: Everything = {}
  let size = 0
  for (const [key, history] of newestFirst) {
    const prompts = history.prompts.slice(-HISTORY_PER_PROJECT)
    let total = prompts.reduce((sum, prompt) => sum + prompt.length, 0)
    // When the whole would be too large, the oldest prompts of the least recent projects go first.
    while (prompts.length > 1 && size + total > HISTORY_MAX_CHARS) total -= prompts.shift()!.length
    if (size + total > HISTORY_MAX_CHARS) continue
    size += total
    kept[key] = { updatedAt: history.updatedAt, prompts }
  }
  return kept
}

function write(storage: PromptStorage, everything: Everything): void {
  try {
    if (Object.keys(everything).length === 0) storage.removeItem(STORAGE_KEY)
    else storage.setItem(STORAGE_KEY, JSON.stringify(trim(everything)))
  } catch { /* Storage can be full or switched off: history is a convenience, so it just does not persist. */ }
}

/** A project's prompts, oldest first. */
export function loadPrompts(storage: PromptStorage, key: string): string[] {
  return read(storage)[key]?.prompts ?? []
}

/** Remember a prompt. An identical one just sent before it is not stored twice, and a very long one is not stored. */
export function recordPrompt(storage: PromptStorage, key: string, text: string, now = Date.now()): void {
  const prompt = text.trim()
  if (!prompt || prompt.length > HISTORY_ENTRY_MAX_CHARS) return
  const everything = read(storage)
  const prompts = everything[key]?.prompts ?? []
  if (prompts.at(-1) === prompt) return
  everything[key] = { updatedAt: now, prompts: [...prompts, prompt] }
  write(storage, everything)
}

/** Forget a project's prompts; returns how many there were. */
export function clearPrompts(storage: PromptStorage, key: string): number {
  const everything = read(storage)
  const removed = everything[key]?.prompts.length ?? 0
  if (removed) {
    delete everything[key]
    write(storage, everything)
  }
  return removed
}

// --- Walking through the prompts with the arrow keys ---------------------------------------------------------------

export interface Recall {
  /** 0 is the newest prompt; null means the composer shows what the person is typing. */
  index: number | null
  /** What was in the composer before the first Up Arrow, for Esc and for coming back down. */
  draft: string
  /** The prompt the composer was last given, so a change made by typing can be told from our own. */
  shown: string
}

export const NOT_RECALLING: Recall = { index: null, draft: '', shown: '' }

export interface RecallStep {
  text: string
  recall: Recall
}

/** Up Arrow: the next older prompt. Undefined when there is none, so the key keeps its usual job. */
export function recallOlder(prompts: readonly string[], recall: Recall, current: string): RecallStep | undefined {
  let next = recall.index === null ? 0 : recall.index + 1
  // Skip a prompt identical to what is on screen, or the key would look like it did nothing.
  while (next < prompts.length && prompts[prompts.length - 1 - next] === current) next++
  const text = prompts[prompts.length - 1 - next]
  if (text === undefined) return undefined
  return { text, recall: { index: next, draft: recall.index === null ? current : recall.draft, shown: text } }
}

/** Down Arrow: the next newer prompt, and past the newest the draft comes back. */
export function recallNewer(prompts: readonly string[], recall: Recall, current: string): RecallStep | undefined {
  if (recall.index === null) return undefined
  let next = recall.index - 1
  while (next >= 0 && prompts[prompts.length - 1 - next] === current) next--
  if (next < 0) return leaveRecall(recall)
  const text = prompts[prompts.length - 1 - next]
  return text === undefined ? leaveRecall(recall) : { text, recall: { index: next, draft: recall.draft, shown: text } }
}

/** Esc: back to the draft that was being typed. */
export function leaveRecall(recall: Recall): RecallStep | undefined {
  return recall.index === null ? undefined : { text: recall.draft, recall: { ...NOT_RECALLING, shown: recall.draft } }
}

/** After the composer text changed: walking through prompts goes on only while the text is still the one it put there. */
export function settleRecall(recall: Recall, text: string): Recall {
  return recall.index !== null && text !== recall.shown ? NOT_RECALLING : recall
}

/**
 * Whether Up Arrow should walk back through prompts rather than move the caret. In an empty composer or at the
 * very start of a draft it should; while walking, anywhere on the first line, so a long prompt can still be read.
 */
export function mayRecallOlder(text: string, selectionStart: number, selectionEnd: number, recalling: boolean): boolean {
  if (selectionStart !== selectionEnd) return false
  return recalling ? !text.slice(0, selectionStart).includes('\n') : selectionStart === 0
}

/** Whether Down Arrow should walk forward: only while walking, and on the last line. */
export function mayRecallNewer(text: string, selectionStart: number, selectionEnd: number, recalling: boolean): boolean {
  return recalling && selectionStart === selectionEnd && !text.slice(selectionEnd).includes('\n')
}
