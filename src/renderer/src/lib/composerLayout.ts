/**
 * How the composer fits its width. The bar of controls under the field gives up its least important words
 * first, and the placeholder picks the longest wording that fits, so nothing is ever cut off mid-sentence.
 */

/** Roomy shows everything; snug drops the effort label; tight also drops the permission label. */
export type ComposerDensity = 'roomy' | 'snug' | 'tight'

/** Below these widths (the composer box, in px) the bar no longer holds its labels: measured with the longest usual names. */
export const SNUG_BELOW = 520
export const TIGHT_BELOW = 420

export function densityFor(width: number): ComposerDensity {
  // Unmeasured is treated as roomy: the layout effect measures before the first paint.
  if (width <= 0) return 'roomy'
  return width < TIGHT_BELOW ? 'tight' : width < SNUG_BELOW ? 'snug' : 'roomy'
}

/**
 * The first candidate that fits `width` once measured. Candidates run from the full wording to the shortest;
 * when none fits the shortest is used and the stylesheet's ellipsis takes the rest.
 */
export function pickFitting(candidates: readonly string[], width: number, measure: (text: string) => number): string {
  if (width <= 0) return candidates[0] ?? ''
  return candidates.find((text) => measure(text) <= width) ?? candidates[candidates.length - 1] ?? ''
}

export type ComposerSituation = 'select-model' | 'add-local-provider' | 'add-provider' | 'summarizing' | 'answer' | 'plan' | 'working' | 'idle'

export interface SituationInput {
  /** A usable model is selected. */
  ready: boolean
  hasProviders: boolean
  localOnly: boolean
  compacting: boolean
  /** A permission or a question waits for the person. */
  asking: boolean
  /** A plan waits for the person's decision. */
  planning: boolean
  /** A turn is running. */
  working: boolean
}

/** What the composer is for right now. */
export function situationOf(input: SituationInput): ComposerSituation {
  if (!input.ready) return input.hasProviders ? 'select-model' : input.localOnly ? 'add-local-provider' : 'add-provider'
  if (input.compacting) return 'summarizing'
  if (input.asking) return 'answer'
  if (input.planning) return 'plan'
  return input.working ? 'working' : 'idle'
}

/**
 * The placeholder for each situation, full wording first. While a turn runs or waits, the field says that Enter
 * queues the message, because that is what it does.
 */
export const PLACEHOLDERS: Record<ComposerSituation, readonly string[]> = {
  'select-model': ['Select a model to start'],
  'add-local-provider': ['Add a local provider to start', 'Add a provider to start'],
  'add-provider': ['Add or enable a provider to start', 'Add a provider to start'],
  summarizing: ['Summarizing earlier messages. Enter queues your next message.', 'Summarizing earlier messages', 'Summarizing'],
  answer: ['Waiting for your answer above. Enter queues your next message.', 'Waiting for your answer above', 'Waiting for your answer'],
  plan: ['Waiting for your decision on the plan. Enter queues your next message.', 'Waiting for your decision on the plan', 'Waiting for your decision'],
  working: ['Cubex is working. Press Enter to queue your next message, or Esc to stop.', 'Working. Enter queues your next message, Esc stops.', 'Enter queues a message, Esc stops', 'Queue the next message'],
  idle: ['Ask Cubex to work on something. Use @ for files and / for commands.', 'Ask Cubex, @ for files, / for commands', 'Ask Cubex']
}
