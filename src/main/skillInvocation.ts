import type { TextPart } from '@core/types'
import { isSkillName, skillLoadFailure } from '@shared/skillInvocation'
import { readSkill, type Skill } from './skills'

export interface InvokedSkill {
  /** The skill as the catalog spells it. */
  skill: Skill
  /** Its instructions, read now. */
  body: string
  /** The instructions as the text that goes in front of the person's own words. */
  part: TextPart
}

/** The name as it appears in a message to the person: printable, and short enough that a bad one cannot flood the line. */
function shown(name: unknown): string {
  return typeof name === 'string' ? name.replace(/[^\x20-\x7e]/g, '?').slice(0, 64) : 'unnamed'
}

/**
 * The instructions as one block. The person chose this skill, so the model is told to follow it; a closing tag
 * inside the body is defused so that the block cannot end early and leave its remaining lines looking like the
 * person's own words.
 */
function instructionPart(name: string, body: string): TextPart {
  const safe = body.replace(/<\/skill\s*>/gi, '<\\/skill>')
  return { type: 'text', text: `The user invoked the "${name}" skill. Follow its instructions for this request.\n\n<skill name="${name}">\n${safe}\n</skill>` }
}

/**
 * Find the skill the person named among the skills this turn offers and read its instructions. The catalog is the
 * only way in: a name the window sends never becomes a path. Throws the sentence the composer shows, and the turn
 * does not start.
 */
export function invokeSkill(skills: readonly Skill[], name: unknown): InvokedSkill {
  if (!isSkillName(name)) throw new Error(skillLoadFailure(shown(name), 'skill names use letters, digits, dots, underscores and hyphens.'))
  const skill = skills.find((entry) => entry.name.toLowerCase() === name.toLowerCase())
  if (!skill) throw new Error(skillLoadFailure(name, 'no skill with that name is available in this task. Type / in the message box to see the ones you can use.'))
  let body: string
  try {
    body = readSkill(skill)
  } catch (error) {
    throw new Error(skillLoadFailure(skill.name, error instanceof Error ? error.message : String(error)))
  }
  return { skill, body, part: instructionPart(skill.name, body) }
}
