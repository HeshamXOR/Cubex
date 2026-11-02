/** How much of the end of the reasoning is read: the newest step always sits in the tail. */
const TAIL_CHARS = 1200
const MAX_CHARS = 90

/**
 * The newest step of a model's reasoning, for the live reasoning bar: the last
 * non-empty sentence, with markdown markers removed and cut to about 90 characters.
 * Reads only the tail, because it runs on every streamed delta of text that can
 * grow to tens of kilobytes.
 */
export function latestReasoningStep(text: string): string {
  if (!text) return ''
  const tail = text.length > TAIL_CHARS ? text.slice(-TAIL_CHARS) : text
  const lines = tail.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const sentences = lines[i]!.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean)
    for (let j = sentences.length - 1; j >= 0; j--) {
      const cleaned = sentences[j]!
        .replace(/^[#*`\->\s]+/, '')
        .replace(/^\d+\.\s*/, '')
        .replace(/[`*]/g, '')
        .replace(/\s*—\s*/g, ' - ')
        .replace(/·/g, ' ')
        .trim()
      if (!cleaned) continue
      return cleaned.length > MAX_CHARS ? `${cleaned.slice(0, MAX_CHARS - 3).trimEnd()}...` : cleaned
    }
  }
  return ''
}
