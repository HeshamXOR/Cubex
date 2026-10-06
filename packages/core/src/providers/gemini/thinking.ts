/**
 * How each Gemini model family takes reasoning depth, and which depths it
 * accepts. The two generations use different parameters and are not
 * interchangeable (the API errors on `thinkingLevel` for a 2.5 model):
 *  - Gemini 3 and later: `thinkingConfig.thinkingLevel`
 *    (minimal | low | medium | high; the allowed subset varies per model);
 *  - Gemini 2.5: `thinkingConfig.thinkingBudget` in tokens
 *    (0 turns thinking off where allowed, -1 lets the model decide).
 * Thought summaries only stream when `includeThoughts` is true, so it is sent
 * with every request to a thinking model. Source: the Gemini API thinking
 * guide and the v1beta ThinkingConfig reference.
 *
 * Pure and dependency-free; effort.ts builds the UI options from it and
 * translate.ts the request parameters, so the two cannot disagree.
 */
import type { ReasoningEffort } from '../../types/request'

export type GeminiThinkingLevel = 'minimal' | 'low' | 'medium' | 'high'
export type GeminiThinkingControl = 'level' | 'budget'

export interface GeminiEffortChoice {
  /** The unified value stored in settings and presets. */
  value: ReasoningEffort
  label: string
  hint: string
  /** Wire value for Gemini 3 models. */
  level?: GeminiThinkingLevel
  /** Wire value for Gemini 2.5 models (0 = off, -1 = dynamic). */
  budget?: number
}

export interface GeminiThinkingProfile {
  /** Absent when the model thinks but its depth cannot be controlled here. */
  control?: GeminiThinkingControl
  choices: GeminiEffortChoice[]
}

export interface GeminiThinkingConfig {
  includeThoughts: true
  thinkingLevel?: GeminiThinkingLevel
  thinkingBudget?: number
}

/** Image, speech, realtime and embedding variants are not chat reasoning models. */
const NON_CHAT = /(^|-)(tts|image|imagen|live|native-audio|embedding|veo|aqa)(-|$)/
const ALIAS = /^gemini-(?:pro|flash|flash-lite)-latest$/
const FAMILY = /^gemini-(\d+)(?:\.(\d+))?-(flash-lite|flash|pro)(?:-|$)/

type Tier = 'pro' | 'flash' | 'flash-lite'

const LEVEL_COPY: Record<GeminiThinkingLevel, GeminiEffortChoice> = {
  minimal: { value: 'minimal', label: 'Minimal', hint: 'Little to no thinking; lowest latency', level: 'minimal' },
  low: { value: 'low', label: 'Low', hint: 'Light reasoning; fast', level: 'low' },
  medium: { value: 'medium', label: 'Medium', hint: 'Balanced (recommended)', level: 'medium' },
  high: { value: 'high', label: 'High', hint: 'Deepest reasoning', level: 'high' }
}

const LEVELS_FULL: GeminiThinkingLevel[] = ['minimal', 'low', 'medium', 'high']
const LEVELS_NO_MINIMAL: GeminiThinkingLevel[] = ['low', 'medium', 'high']
/** The levels every Gemini 3 model accepts; used for generations not known yet. */
const LEVELS_SAFE: GeminiThinkingLevel[] = ['low', 'high']

/** Levels per Gemini 3 model: `minimal` and `medium` are API errors on some of them. */
function levelsFor(major: number, minor: number | undefined, tier: Tier): GeminiThinkingLevel[] {
  if (major !== 3) return LEVELS_SAFE
  if (tier === 'pro') return minor === 1 ? LEVELS_NO_MINIMAL : LEVELS_SAFE
  if (tier === 'flash-lite') return minor === 1 || minor === 5 ? LEVELS_FULL : LEVELS_SAFE
  if (minor === undefined || minor === 5 || minor === 6) return LEVELS_FULL
  return minor === 7 || minor === 8 ? LEVELS_NO_MINIMAL : LEVELS_SAFE
}

function tokens(n: number): string {
  return `${n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')} thinking tokens`
}

function budget(value: ReasoningEffort, label: string, hint: string, tokensBudget: number): GeminiEffortChoice {
  return { value, label, hint, budget: tokensBudget }
}

/** 2.5 budgets. Pro cannot switch thinking off (minimum 128); Flash can (0). */
function budgetChoices(tier: Tier): GeminiEffortChoice[] {
  const low = budget('low', 'Low', tokens(1024), 1024)
  const medium = budget('medium', 'Medium', tokens(8192), 8192)
  const high = budget('high', 'High', tokens(24576), 24576)
  if (tier === 'pro') {
    return [
      budget('minimal', 'Minimum', `Smallest budget Pro allows (${tokens(128)})`, 128),
      low,
      medium,
      high,
      budget('max', 'Max', tokens(32768), 32768)
    ]
  }
  // Flash-Lite thinks only when asked, so it offers a dynamic budget instead of "off".
  if (tier === 'flash-lite') {
    return [low, budget('medium', 'Dynamic', 'The model decides how much to think', -1), high]
  }
  return [budget('minimal', 'Off', 'Thinking off (budget 0)', 0), low, medium, high]
}

/**
 * The thinking behavior of a model, or undefined when it does not think and must
 * not be sent a thinkingConfig. `supportsThinking` is the models-endpoint
 * `thinking` flag when it is known; it wins over what the id suggests.
 */
export function geminiThinkingProfile(modelId: string, supportsThinking?: boolean): GeminiThinkingProfile | undefined {
  if (supportsThinking === false) return undefined
  const id = modelId.toLowerCase().replace(/^models\//, '')
  const unknown: GeminiThinkingProfile | undefined = supportsThinking ? { choices: [] } : undefined
  if (NON_CHAT.test(id)) return unknown
  // "-latest" aliases move between generations, so they can think but their control is unknown.
  if (ALIAS.test(id)) return { choices: [] }
  const match = FAMILY.exec(id)
  if (!match) return unknown
  const major = Number(match[1])
  const minor = match[2] === undefined ? undefined : Number(match[2])
  const tier = match[3] as Tier
  if (major >= 3) {
    return { control: 'level', choices: levelsFor(major, minor, tier).map((level) => LEVEL_COPY[level]) }
  }
  if (major === 2 && minor === 5) return { control: 'budget', choices: budgetChoices(tier) }
  return unknown
}

/** The options a model offers beyond its default (empty when depth is not controllable). */
export function geminiEffortChoices(modelId: string, supportsThinking?: boolean): GeminiEffortChoice[] {
  return geminiThinkingProfile(modelId, supportsThinking)?.choices ?? []
}

const RANK: Record<ReasoningEffort, number> = { minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 }

/** The exact option, else the closest one; a tie goes up so reasoning is not silently cut. */
function nearestChoice(choices: GeminiEffortChoice[], effort: ReasoningEffort): GeminiEffortChoice | undefined {
  let best: GeminiEffortChoice | undefined
  for (const choice of choices) {
    if (choice.value === effort) return choice
    if (!best) {
      best = choice
      continue
    }
    const distance = Math.abs(RANK[choice.value] - RANK[effort])
    const bestDistance = Math.abs(RANK[best.value] - RANK[effort])
    if (distance < bestDistance || (distance === bestDistance && RANK[choice.value] > RANK[best.value])) best = choice
  }
  return best
}

/**
 * The `generationConfig.thinkingConfig` for a request, or undefined for a model
 * that does not think. Thought summaries are always requested; a depth is sent
 * only when the caller chose one.
 */
export function geminiThinkingConfig(
  modelId: string,
  effort: ReasoningEffort | undefined,
  supportsThinking?: boolean
): GeminiThinkingConfig | undefined {
  const profile = geminiThinkingProfile(modelId, supportsThinking)
  if (!profile) return undefined
  const config: GeminiThinkingConfig = { includeThoughts: true }
  const choice = effort === undefined ? undefined : nearestChoice(profile.choices, effort)
  if (choice?.level !== undefined) config.thinkingLevel = choice.level
  if (choice?.budget !== undefined) config.thinkingBudget = choice.budget
  return config
}
