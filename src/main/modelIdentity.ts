import type { ModelInfo } from '@core/types'

/**
 * Who the model is, as far as the picker says. The harness tells a model its own name and maker and that
 * Cubex is the app it works in, instead of giving it a new name: a model told it is something else
 * answers questions about itself wrongly, and an instruction that rewrites who it is reads as an attempt to
 * override it.
 */
export interface ModelIdentity {
  /** What the picker shows: the model's display name, or its id. */
  name: string
  /** The exact id sent to the provider, when the name is something else. */
  id?: string
  /** The organisation that made the model, when the id says which. */
  vendor?: string
}

/** First match wins: the more specific families come before the ones their names contain. */
const VENDORS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|[/:_-])claude([-_.\d]|$)|anthropic/i, 'Anthropic'],
  [/(^|[/:_-])(gpt-oss|gpt|chatgpt|o[1-9](-|$))|openai/i, 'OpenAI'],
  [/(^|[/:_-])(gemini|gemma|palm|learnlm)|google\//i, 'Google'],
  [/(^|[/:_-])grok|(^|\/)xai\//i, 'xAI'],
  [/kimi|moonshot/i, 'Moonshot AI'],
  [/(^|[/:_-])(glm|chatglm|codegeex)|z-ai\/|zai-org|zhipu/i, 'Z.ai'],
  [/deepseek/i, 'DeepSeek'],
  [/(^|[/:_-])(qwen|qwq|qvq)|alibaba/i, 'Alibaba Cloud (Qwen)'],
  [/minimax/i, 'MiniMax'],
  [/(^|[/:_-])(mistral|mixtral|codestral|devstral|magistral|ministral|pixtral)|mistralai\//i, 'Mistral AI'],
  [/nemotron|(^|\/)nvidia\//i, 'NVIDIA'],
  [/(^|[/:_-])(llama|codellama)|(^|\/)meta\//i, 'Meta'],
  [/(^|[/:_-])phi-\d|(^|\/)microsoft\//i, 'Microsoft'],
  [/(^|[/:_-])(command|aya)(-|$)|cohere/i, 'Cohere'],
  [/(^|[/:_-])ernie|baidu/i, 'Baidu'],
  [/hunyuan|tencent/i, 'Tencent'],
  [/doubao|seed-oss|bytedance/i, 'ByteDance'],
  [/(^|[/:_-])granite|(^|\/)ibm/i, 'IBM'],
  [/(^|[/:_-])jamba|ai21/i, 'AI21 Labs'],
  [/(^|[/:_-])sonar|perplexity/i, 'Perplexity'],
  [/(^|[/:_-])step-\d|stepfun/i, 'StepFun'],
  [/(^|[/:_-])yi-|01-ai/i, '01.AI'],
  [/olmo|allenai/i, 'Allen Institute for AI']
]

export function modelVendor(modelId: string): string | undefined {
  return VENDORS.find(([pattern]) => pattern.test(modelId))?.[1]
}

/** The identity to tell the model: its picker name, exact id and maker. */
export function modelIdentity(modelId: string, info?: Pick<ModelInfo, 'displayName'>): ModelIdentity {
  const shown = info?.displayName?.trim()
  const vendor = modelVendor(modelId)
  // A listing that only echoes the id has no name to offer.
  const named = shown && shown.toLowerCase() !== modelId.toLowerCase()
  return {
    name: named ? shown : modelId,
    ...(named ? { id: modelId } : {}),
    ...(vendor ? { vendor } : {})
  }
}

/** "Claude Sonnet 5.5 (model id claude-sonnet-5-5), made by Anthropic". */
export function describeIdentity(identity: ModelIdentity): string {
  return `${identity.name}${identity.id ? ` (model id ${identity.id})` : ''}${identity.vendor ? `, made by ${identity.vendor}` : ''}`
}
