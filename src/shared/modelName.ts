/**
 * A model name as a local runtime takes it: `llama3.1:8b`, `someone/model:tag`,
 * `hf.co/owner/repo:Q4_K_M`. Starts with a letter or digit and holds only the
 * characters those names use, so a typo with a space in it is caught before it
 * is sent anywhere. Shared so the form and the main process agree.
 */
export const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/

export function isModelName(value: string): boolean {
  return MODEL_NAME_PATTERN.test(value)
}

export const MODEL_NAME_HINT = 'Enter a model name such as llama3.1:8b.'
