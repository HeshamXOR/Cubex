import type { ProviderKind } from '@core/types'
import type { HarnessProfileSetting } from '@shared/settings'

export type { HarnessProfileSetting }

/**
 * How the harness presents itself to a model. Every model used to get the same ~35 tools and the same long prompt,
 * but small and open models pick the right tool more reliably from a shorter list. A profile says which edit tool a
 * model is trained on, how much of the tool set it is shown, and a few related defaults. It is a pure function of the
 * model's id and where it runs, so a conversation sees the same tools every turn.
 */
export type EditTool = 'edit_file' | 'apply_patch'
export type HarnessTier = 'full' | 'lean'

export interface HarnessProfile {
  /** The one whole-file-edit tool this model is offered. `apply_patch` for models trained on that envelope. */
  editTool: EditTool
  tier: HarnessTier
  /** Whether the model is trusted to ask for several tools in one reply. Lean models are told to go one at a time. */
  parallelTools: boolean
  /** A sampling temperature for models that do badly at the API default. Never overrides a temperature the person set. */
  temperature?: number
  /** The top-p their makers recommend alongside it. */
  topP?: number
}

export interface ProfileInput {
  providerKind?: ProviderKind
  modelId: string
  displayName?: string
  /** The model runs on this computer (the runtime, not the cloud). */
  isLocal?: boolean
  /** Billions of parameters, when the listing says. */
  parameterCount?: number
  /** The Settings choice; absent is `auto`. */
  setting?: HarnessProfileSetting
}

/** A name starts at the beginning or after a separator, so `phi-4` matches but `sapphire` does not. */
const START = String.raw`(?:^|[/:_\s.-])`

/** Open-weight families and the labs that mostly ship them. Their tool use is weaker with many choices. */
const LEAN_FAMILIES = new RegExp(`${START}(?:` + [
  'deepseek', 'qwen', 'qwq', 'qvq', 'glm', 'chatglm', 'codegeex', 'kimi', 'moonshot',
  'llama', 'codellama', 'mistral', 'mixtral', 'codestral', 'devstral', 'magistral', 'ministral', 'pixtral',
  'nemotron', 'phi-?\\d', 'gemma', 'granite', 'olmo', 'smollm', 'internlm', 'minimax', 'hermes', 'starcoder',
  'gpt-oss', 'seed-oss', 'yi-\\d'
].join('|') + ')', 'i')

/** Small variants of any family, hosted or not. */
const SMALL_VARIANT = new RegExp(`${START}(?:nano|lite|tiny)(?:$|[/:_\\s.-])`, 'i')

/**
 * Models trained on the `*** Begin Patch` envelope: GPT-4.1 and later, GPT-5, the o-series and the Codex models.
 * gpt-oss and GPT-4o are not among them.
 */
const PATCH_TRAINED = new RegExp(`${START}(?:gpt-?4\\.1|gpt-?[5-9]|o[1-9](?:$|[-_.\\s])|[a-z-]*codex)`, 'i')
const NOT_PATCH_TRAINED = /gpt-?oss/i

const LOCAL_KINDS: readonly ProviderKind[] = ['ollama', 'llamacpp', 'lmstudio', 'mock-local']

/**
 * Sampling defaults from the makers' own model cards, for models that do badly at the API default of 1.0. Reasoning
 * variants are left alone: Moonshot fixes Kimi K2.5 and later at 1.0 and rejects other values, DeepSeek ignores it in
 * thinking mode, and OpenAI's reasoning models refuse it. So plain Kimi K2 is named here, and K2.5, K2.6, K3 are not.
 */
const SAMPLING: ReadonlyArray<readonly [RegExp, { temperature: number; topP?: number }]> = [
  [/kimi-k2(?![.\d])/i, { temperature: 0.6 }],
  [/qwen-?3.*coder|qwen2\.5.*coder/i, { temperature: 0.7, topP: 0.8 }]
]

const THINKING = /think|reason|-r1\b|\bo[1-9]\b/i

function isLean(input: ProfileInput, name: string): boolean {
  if (input.isLocal || (input.providerKind && LOCAL_KINDS.includes(input.providerKind))) return true
  if (typeof input.parameterCount === 'number' && input.parameterCount > 0 && input.parameterCount <= 32) return true
  return LEAN_FAMILIES.test(name) || SMALL_VARIANT.test(name)
}

/** The profile for one model. Unknown hosted models get the full tool set; unknown local ones the lean set. */
export function profileFor(input: ProfileInput): HarnessProfile {
  const name = `${input.modelId} ${input.displayName ?? ''}`.toLowerCase()
  const tier: HarnessTier = input.setting === 'full' || input.setting === 'lean' ? input.setting : isLean(input, name) ? 'lean' : 'full'
  const editTool: EditTool = PATCH_TRAINED.test(name) && !NOT_PATCH_TRAINED.test(name) ? 'apply_patch' : 'edit_file'
  const sampling = THINKING.test(name) ? undefined : SAMPLING.find(([pattern]) => pattern.test(name))?.[1]
  return { editTool, tier, parallelTools: tier === 'full', ...sampling }
}

/** Tools a lean profile does not offer: rarely needed, easy to pick by mistake, or reachable another way (git through run_command). */
const LEAN_DROPPED = [
  'multi_edit', 'apply_patch', 'git_commit', 'git_branch', 'git_log', 'git_show', 'git_blame',
  'delegate_to_subagent', 'consult_agent', 'delegate_task', 'task_input', 'remember'
]

export interface ToolFilterContext {
  /** The turn runs in plan mode. */
  planMode?: boolean
  /** The user's message names a skill, or the composer applied one. */
  skillNamed?: boolean
  /** The user's message is about a web page. */
  browserNamed?: boolean
}

/**
 * The names of the tools to take out of this turn's set. Only the tools listed here are ever removed, so what a mode
 * or an in-progress feature depends on (exit_plan_mode, goal_update, ask_user_question, todo_write, the file
 * writers, the shell and its task tools, MCP tools the person added) stays whatever the profile.
 */
export function toolsToDrop(names: Iterable<string>, profile: HarnessProfile, context: ToolFilterContext = {}): Set<string> {
  const present = new Set(names)
  const drop = new Set<string>()
  // Exactly one whole-file edit style: the model's own. If its tool is missing, the other stays rather than leaving no editor.
  const other: EditTool = profile.editTool === 'apply_patch' ? 'edit_file' : 'apply_patch'
  if (present.has(profile.editTool)) drop.add(other)
  // multi_edit is the batched form of edit_file, so it only makes sense beside it.
  if (profile.editTool === 'apply_patch') drop.add('multi_edit')
  if (profile.tier === 'lean') {
    for (const name of LEAN_DROPPED) drop.add(name)
    if (profile.editTool === 'apply_patch') drop.delete('apply_patch')
    if (!context.planMode) drop.add('read_plan')
    if (!context.skillNamed) drop.add('skill')
    if (!context.browserNamed) drop.add('browser')
  }
  return new Set([...drop].filter((name) => present.has(name)))
}

/**
 * Whether a message names one of the skills: `$name` or `/name`, or the name beside the word "skill"
 * ("use the code-review skill"). A bare name is not enough; "review" in a sentence is not a request.
 */
export function namesSkill(text: string, skillNames: readonly string[]): boolean {
  if (!text || skillNames.length === 0) return false
  const lower = text.toLowerCase()
  const mentionsSkill = /\bskills?\b/.test(lower)
  for (const name of skillNames) {
    const escaped = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(?:^|[\\s(])[$/]${escaped}(?![\\w.-])`).test(lower)) return true
    if (mentionsSkill && new RegExp(`(?:^|[^\\w$/-])${escaped}(?![\\w-])`).test(lower)) return true
  }
  return false
}

/** Whether a message is about something seen in a browser, so that a lean model is offered one too. */
export function namesBrowser(text: string): boolean {
  return /\b(?:browser|localhost|web ?page|web ?app|website|screenshot|front-?end|ui|css|html|react|vue|svelte|dev server)\b/i.test(text)
}

/** The Settings value as a known choice; anything else reads as `auto`. */
export function readProfileSetting(value: unknown): HarnessProfileSetting {
  return value === 'full' || value === 'lean' ? value : 'auto'
}
