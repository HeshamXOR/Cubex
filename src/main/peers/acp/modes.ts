/**
 * Which mode an agent works in. Agents advertise modes (Claude Code's "plan", Codex's "read-only", Gemini's "yolo") that
 * decide how much they do without asking. Cubex holds an agent to a policy by answering its permission questions, and a
 * mode that never asks cannot be held to anything. So it picks the mode that fits the job from the ones the agent offers,
 * and refuses to use an agent that is in a mode that does things without asking and has no suitable one to move to.
 *
 * There are two jobs. A consultation only looks and answers: the most careful mode is the right one. A task changes the
 * project, so the agent has to be able to ask before it does: a mode that asks comes first, then a read-only mode (which in
 * several agents asks before it edits), and plan, chat and "ask" modes never, because an agent in one cannot change a thing.
 *
 * Modes are known by their words, because the protocol gives them only an id and a name. A mode Cubex does not
 * recognise is not trusted.
 */

export interface AcpMode {
  id: string
  name: string
}

/** From most careful to least. `unsafe` and `unknown` are never chosen. */
export type ModeKind = 'readonly' | 'plan' | 'ask' | 'chat' | 'asks' | 'unsafe' | 'unknown'

export type ModePurpose = 'consult' | 'work'

/** The order in which a careful mode is preferred for a consultation. */
const PREFERRED: readonly ModeKind[] = ['readonly', 'plan', 'ask', 'chat', 'asks']
/** For a task: the modes in which an agent asks before it changes something. */
const WORKING: readonly ModeKind[] = ['asks', 'readonly']

/** The words of an id or a name, lower case, with anything that is not a letter or digit as a space. "acceptEdits" is two words. */
function words(text: string): string {
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  return ` ${spaced} `
}

const UNSAFE = [
  /\bbypass/, /\byolo\b/, /\bdanger/, /\bfull (access|auto)\b/, /\bfullaccess\b/, /\bskip/, /\bunrestricted\b/, /\bautopilot\b/,
  /\bdon ?t ask\b/, /\bdont ?ask\b/, /\bnever ask\b/, /\bno (prompt|permission|approval|confirmation)s?\b/, /\btrust all\b/,
  /\bauto ?(approve|accept|edit)s?\b/, /\baccept ?edits\b/, /\bauto\b/
]

export function classifyMode(mode: AcpMode): ModeKind {
  const text = `${words(mode.id)}${words(mode.name)}`
  if (UNSAFE.some((pattern) => pattern.test(text))) return 'unsafe'
  if (/\bread ?only\b/.test(text)) return 'readonly'
  if (/\bplan(ning)?\b/.test(text)) return 'plan'
  if (/\b(ask|question|questions)\b/.test(text)) return 'ask'
  if (/\bchat\b/.test(text)) return 'chat'
  if (/\b(approve|approval|approvals|manual|default|normal|confirm|supervised)\b/.test(text)) return 'asks'
  return 'unknown'
}

/** Whether a mode is one a consultation can run in. */
export function isCareful(kind: ModeKind): boolean {
  return kind !== 'unsafe' && kind !== 'unknown'
}

/** Whether a mode is one the job can run in: a consultation in any careful mode, a task in one that asks before it changes things. */
export function suitsPurpose(kind: ModeKind, purpose: ModePurpose): boolean {
  return purpose === 'work' ? WORKING.includes(kind) : isCareful(kind)
}

export type ModeChoice =
  | { action: 'keep' }
  | { action: 'set'; mode: AcpMode }
  /** The agent is in a mode that is not careful, and there is none to move to. */
  | { action: 'refuse'; current: AcpMode; why?: undefined }
  /** A task needs a mode in which the agent asks before it changes things, and the agent offers none. */
  | { action: 'refuse'; why: 'nothing-asks'; offered: AcpMode[]; current?: AcpMode }

/** What to do about the mode a new session starts in. */
export function chooseMode(current: string | undefined, available: readonly AcpMode[], purpose: ModePurpose = 'consult'): ModeChoice {
  const order = purpose === 'work' ? WORKING : PREFERRED
  const modes = available.map((mode) => ({ mode, kind: classifyMode(mode) }))
  const now = modes.find((entry) => entry.mode.id === current)
  let best: (typeof modes)[number] | undefined
  for (const kind of order) {
    best = modes.find((entry) => entry.kind === kind)
    if (best) break
  }
  if (!best) {
    // An agent without modes cannot be checked at all, and is judged by its answers alone.
    if (purpose === 'work') return modes.length > 0 ? { action: 'refuse', why: 'nothing-asks', offered: [...available], ...(now ? { current: now.mode } : {}) } : { action: 'keep' }
    // Nothing careful is on offer. An agent in a mode that is not listed is judged by its answers alone.
    return now && !isCareful(now.kind) ? { action: 'refuse', current: now.mode } : { action: 'keep' }
  }
  if (now && order.indexOf(now.kind) >= 0 && order.indexOf(now.kind) <= order.indexOf(best.kind)) return { action: 'keep' }
  return { action: 'set', mode: best.mode }
}

/** Whether an agent could take a task that changes the project, judged from the modes it offers. */
export type TaskReadiness =
  /** It offers a mode in which it asks first, which a task would run in. With no mode it offers none at all, and is judged by its answers alone. */
  | { ready: true; mode?: AcpMode }
  /** It offers modes and none of them asks first, so it can only take tasks that read. */
  | { ready: false; offered: AcpMode[] }

export function taskReadiness(available: readonly AcpMode[]): TaskReadiness {
  const choice = chooseMode(undefined, available, 'work')
  if (choice.action === 'set') return { ready: true, mode: choice.mode }
  if (choice.action === 'refuse' && choice.why === 'nothing-asks') return { ready: false, offered: choice.offered }
  return { ready: true }
}

const MODE_NAME_CHARS = 40
const MODE_NAMES_SHOWN = 6

/** The names of modes as a sentence lists them. An agent chooses these words, so they are cleaned and kept short. */
export function modeNames(modes: readonly AcpMode[]): string {
  const names = modes.slice(0, MODE_NAMES_SHOWN).map((mode) => {
    const name = mode.name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
    return name.length > MODE_NAME_CHARS ? `${name.slice(0, MODE_NAME_CHARS)}…` : name
  })
  return modes.length > MODE_NAMES_SHOWN ? `${names.join(', ')} and ${modes.length - MODE_NAMES_SHOWN} more` : names.join(', ')
}

/** What a test says about it, for the person who is deciding whether to give the agent tasks. */
export function readinessNote(readiness: TaskReadiness): string {
  if (!readiness.ready) {
    return `Can take research and review tasks, but not tasks that change the project: it has no mode in which it asks before it changes things (it offers: ${modeNames(readiness.offered)}).`
  }
  if (!readiness.mode) return 'Can take any kind of task. It offers no modes, so Cubex judges it by the questions it asks.'
  return `Can take any kind of task. It works in its "${modeNames([readiness.mode])}" mode, which asks before it changes things.`
}
