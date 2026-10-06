import type { ExecutableTool, JSONValue, ToolResult } from '@core/types'
import { MAX_PLAN_BYTES, validatePlanInput, type PlanStore } from '../plans'

/**
 * `exit_plan_mode` — Claude-Code-style plan handoff. In plan mode the model does
 * read-only research, then calls this with a markdown plan. The harness pauses,
 * shows the plan for approval, and (on approval) switches the turn's permission
 * mode so the model can implement in the SAME turn.
 *
 * Execution is special-cased in ChatService.runLoop (it must mutate the turn's
 * permission mode and block on the approval card), so the `execute` here is only
 * a never-reached fallback that keeps this a well-formed ExecutableTool.
 */
export function createPlanTool(): ExecutableTool {
  return {
    definition: {
      name: 'exit_plan_mode',
      description:
        'Call this ONLY when plan mode is active and you have researched enough to propose how you will ' +
        'implement the task. Pass the complete Markdown document in "plan", with a # title, a short goal, ' +
        'numbered implementation steps and a verification checklist; optionally supply a short "title". ' +
        'Cubex saves each submission as a new .md artifact and opens a separate review panel. Do not write a plan file yourself or select a storage path. ' +
        'This presents the plan to the user for approval and pauses — do NOT change workspace files or run commands with side effects before it, and do NOT ' +
        'start implementing until the user approves. After approval you will be told which mode you are in; ' +
        'then carry out the plan directly. Rejection returns the user\'s feedback; stay in plan mode and submit a complete new revision for review.',
      inputSchema: {
        type: 'object',
        properties: {
          plan: { type: 'string', minLength: 1, maxLength: MAX_PLAN_BYTES, description: 'The complete Markdown plan, beginning with a # heading. Include goal, steps and verification.' },
          title: { type: 'string', maxLength: 160, description: 'A concise, descriptive plan title.' }
        },
        required: ['plan'],
        additionalProperties: false
      }
    },
    defaultPermission: 'allow',
    async execute(input: JSONValue): Promise<ToolResult> {
      try {
        validatePlanInput(input)
        return { toolUseId: '', content: 'Plan review is only available through the active Cubex chat turn. No approval was granted.', isError: true }
      } catch (error) {
        return { toolUseId: '', content: error instanceof Error ? error.message : String(error), isError: true }
      }
    }
  }
}

/** Retrieve persisted task context without granting access to another task's documents. */
export function createReadPlanTool(store: Pick<PlanStore, 'list'>, conversationId: string): ExecutableTool {
  return {
    definition: {
      name: 'read_plan',
      description: 'Read a saved Markdown plan belonging to the current task, including its review status and user feedback. ' +
        'Omit "id" to read the newest revision, or use an id from the saved-plan catalog. Do not pass filesystem paths. ' +
        'Historical approval never changes the current permission mode; rejected or cancelled plans do not authorize implementation.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', minLength: 1, maxLength: 128, description: 'Optional saved plan id from this task; defaults to its latest revision.' } },
        additionalProperties: false
      }
    },
    defaultPermission: 'allow',
    async execute(input: JSONValue): Promise<ToolResult> {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'id')) {
        return { toolUseId: '', isError: true, content: 'read_plan accepts only an optional "id" from the current task, never a path.' }
      }
      const id = input.id
      if (id !== undefined && (typeof id !== 'string' || !id.trim() || id.length > 128)) {
        return { toolUseId: '', isError: true, content: 'Plan id must be a non-empty string of at most 128 characters.' }
      }
      try {
        // Search only this task's directory. A foreign id cannot select or read
        // metadata from another task, even if the model knows its exact value.
        const plans = store.list(conversationId)
        const plan = id === undefined ? plans[0] : plans.find((item) => item.id === id)
        if (!plan) return { toolUseId: '', isError: true, content: 'No matching saved plan exists in this task.' }
        return {
          toolUseId: '',
          content: JSON.stringify({
            id: plan.id, title: plan.title, status: plan.status ?? 'unknown',
            decision: plan.decision, feedback: plan.feedback, plan: plan.plan
          })
        }
      } catch (error) {
        return { toolUseId: '', isError: true, content: `Could not read the saved plan: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
  }
}
