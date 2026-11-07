/**
 * Families known to take images, for a gateway whose model list does not say. An unknown model is assumed not to: the page's text
 * and the file's text work for every model, and an image a model cannot take fails its request.
 */
const SEES_IMAGES = /(?:^|\/)(?:claude-|gpt-(?:4o|4\.[0-9]|[5-9])|chatgpt-|gemini-|grok-(?:[4-9]))/i

export function knownToSeeImages(modelId: string): boolean {
  return SEES_IMAGES.test(modelId) && !/embedding|whisper|tts|audio|image-/i.test(modelId)
}
