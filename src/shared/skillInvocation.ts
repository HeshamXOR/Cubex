/**
 * Running a skill by name from the composer ("/code-review the diff"). The window and the main process both
 * need these rules, so a name is checked the same way at each end and the person reads the same words.
 */
import type { SkillSummary } from './ipc'

/** Where a skill comes from, in the words the person reads. */
export const SKILL_SOURCE_LABEL: Record<SkillSummary['source'], string> = {
  bundled: 'Cubex library',
  cubex: 'This project',
  claude: 'Claude',
  agents: 'Agents'
}

/** The names a skill may have; the skill catalog applies the same rule when it reads a pack. */
const SKILL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

export function isSkillName(value: unknown): value is string {
  return typeof value === 'string' && SKILL_NAME.test(value)
}

/** What a turn says when the person named a skill and wrote nothing else. */
export function skillTurnText(name: string, request: string): string {
  return request.trim() || `Use the ${name} skill.`
}

const FAILURE_START = 'Could not load the "'

/** The sentence shown when a named skill cannot be applied. The turn did not start. */
export function skillLoadFailure(name: string, reason: string): string {
  return `${FAILURE_START}${name}" skill: ${reason}`
}

/** Whether an error from starting a turn is that sentence, so the window can tell it from a failure of the request itself. */
export function isSkillLoadFailure(message: string): boolean {
  return message.startsWith(FAILURE_START)
}
