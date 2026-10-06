import type { RoutingPolicy, ToolCall } from '@core/types'

/**
 * A reply that reached the output limit holds half of whatever it was writing. A tool call cut that way arrives
 * with arguments that are not valid JSON (the stream accumulator keeps the text it got as `_raw`). Running it
 * would write a truncated file or fail with a confusing "path is required", so the harness tells the model
 * what happened instead.
 */

/** A tool call whose arguments could not be read as JSON. */
export function isUnparsedInput(input: unknown): boolean {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false
  const keys = Object.keys(input)
  return keys.length === 1 && keys[0] === '_raw' && typeof (input as { _raw?: unknown })._raw === 'string'
}

export function hasUnparsedCall(calls: readonly Pick<ToolCall, 'input'>[]): boolean {
  return calls.some((call) => isUnparsedInput(call.input))
}

const tokens = (count: number): string => count.toLocaleString('en-US')

/** What the model reads in place of a result when one call's arguments were not valid JSON. */
export function unreadableArgumentsResult(name: string): string {
  return `The arguments of this "${name}" call were not valid JSON, so it was not run. Send the call again with a single JSON object that matches the tool's input schema.`
}

/** The note that follows a reply whose tool call was cut off: nothing ran, and how to go on. */
export function cutOffCallNote(limit: number, raisedTo: number | undefined): string {
  return `Note from the app: your last reply stopped at the output limit of ${tokens(limit)} tokens while you were writing a tool call, so that call was cut off and nothing was run. ` +
    (raisedTo ? `The limit is now ${tokens(raisedTo)} tokens. ` : '') +
    'Make the call again. If its content is large, build it in smaller steps: write a short first version of the file, then add the remaining parts with edit_file.'
}

/** Shown to the person when a turn ends because replies keep reaching the limit inside a tool call. */
export function repeatedCutOffNotice(limit: number, modelMax: number | undefined): string {
  return `\n\n_The model's replies keep reaching the output limit of ${tokens(limit)} tokens while it writes a tool call, so nothing was written. ` +
    `${modelMax && modelMax > limit ? `Raise "Max output" in Details (this model allows up to ${tokens(modelMax)}), or ` : 'Ask for '}a smaller result and try again._`
}

/** Shown after a reply that stopped at the limit with no tool call: the answer ends mid-way. */
export function cutOffReplyNotice(limit: number, spentThinking: boolean): string {
  return spentThinking
    ? `\n\n_The model used its whole output limit of ${tokens(limit)} tokens thinking and wrote no answer. Lower the thinking level or raise "Max output" in Details._`
    : `\n\n_The reply stopped because it reached the output limit of ${tokens(limit)} tokens. Send "continue" to go on, or raise "Max output" in Details._`
}

/** The same routing with one answer limit for the primary model. */
export function withOutputLimit(policy: RoutingPolicy, limit: number): RoutingPolicy {
  return { ...policy, primary: { ...policy.primary, params: { ...policy.primary.params, maxOutputTokens: limit } } }
}
