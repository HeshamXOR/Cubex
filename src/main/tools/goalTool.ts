import type { ExecutableTool, JSONValue, ToolResult } from '@core/types'
import { GOAL_LIMITS, GOAL_TOOL, type GoalClaim } from '@shared/goal'

/**
 * `goal_update`: the agent says where the goal stands. It changes nothing in the project, so it runs without a prompt.
 * What it says is a claim, not a verdict: the window has the turn judged (a check command, or a model reading the
 * record) before the goal is called complete. It is only offered while a goal is active.
 */
export function createGoalTool(onClaim: (claim: GoalClaim) => void): ExecutableTool {
  return {
    definition: {
      name: GOAL_TOOL,
      description:
        'Tell Cubex where the goal stands. Call it once, at the end of your work for this turn. ' +
        'status "complete": the goal is met. The note says what you ran to check it and what that showed. ' +
        'Cubex then checks the claim, so a note with no evidence is sent back. ' +
        'status "blocked": you cannot go on without the person. The note says exactly what you need. ' +
        'Do not call it while work remains: just keep working, or end your reply and Cubex sends you back.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['complete', 'blocked'], description: 'complete when the goal is met, blocked when you need the person.' },
          note: { type: 'string', maxLength: GOAL_LIMITS.note, description: 'For complete: what you ran and what it showed. For blocked: what you need.' }
        },
        required: ['status', 'note'],
        additionalProperties: false
      }
    },
    defaultPermission: 'allow',
    async execute(input: JSONValue): Promise<ToolResult> {
      const { status, note } = (input ?? {}) as { status?: unknown; note?: unknown }
      if (status !== 'complete' && status !== 'blocked') {
        return { toolUseId: '', isError: true, content: 'status must be "complete" or "blocked". To keep working, just keep working: do not call this tool.' }
      }
      const text = typeof note === 'string' ? note.trim() : ''
      if (!text) {
        return { toolUseId: '', isError: true, content: status === 'complete'
          ? 'Add a note with the evidence: what you ran to check the goal and what it showed.'
          : 'Add a note saying exactly what you need from the person.' }
      }
      onClaim({ status, note: text.slice(0, GOAL_LIMITS.note) })
      return { toolUseId: '', content: status === 'complete'
        ? 'Recorded. Cubex will now check the goal. End your reply with a short summary of what you did.'
        : 'Recorded. Cubex will show the person what you need. End your reply with a short summary of where things stand.' }
    }
  }
}
