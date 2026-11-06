import { canonicalInput } from './repeatGuard'

/**
 * Notices a model going round in circles in ways the repeat guard cannot see, because the calls differ: the same error
 * coming back from different attempts, two actions taking turns, the same file read over and over without an edit. These
 * are the patterns shipping harnesses watch for (OpenHands, Gemini CLI, Crush), and benchmark data ties long runs of them to
 * failed tasks. It only ever adds a note to a tool result, telling the model what it is doing and to change course. A
 * second and later note asks for more: a written new plan before anything else.
 */

const ERROR_WINDOW = 15
const ERROR_NOTE_AT: ReadonlySet<number> = new Set([3, 5, 8])
const SAME_FILE_READS = 4
const ALTERNATION_LENGTH = 6

/** Numbers, hex ids and timings change between attempts at the same error; the words do not. */
function errorKey(text: string): string {
  return text
    .slice(0, 600)
    .toLowerCase()
    .replace(/0x[0-9a-f]+|\b[0-9a-f]{7,}\b|\d+(?:\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
}

/** A command that ran and failed reports it in its result, not always as a tool error. */
const looksFailed = (name: string, text: string, isError: boolean): boolean =>
  isError || (name === 'run_command' && /^exit code: [1-9]/im.test(text))

export class StallDetector {
  private readonly errors: string[] = []
  private readonly calls: Array<{ signature: string; edits: number }> = []
  private readonly reads = new Map<string, number>()
  private lastEdits = 0
  private notes = 0

  /** Record a finished call. Returns a note to add to its result when the model looks stuck. */
  record(name: string, input: unknown, text: string, isError: boolean, edits: number): string | undefined {
    if (edits !== this.lastEdits) {
      this.lastEdits = edits
      this.reads.clear()
    }
    const found = this.sameError(name, text, isError) ?? this.sameFile(name, input, isError) ?? this.alternating(name, input, edits)
    return found ? this.escalated(found) : undefined
  }

  reset(): void {
    this.errors.length = 0
    this.calls.length = 0
    this.reads.clear()
    this.notes = 0
  }

  private sameError(name: string, text: string, isError: boolean): string | undefined {
    if (!looksFailed(name, text, isError)) return undefined
    const key = errorKey(text)
    this.errors.push(key)
    if (this.errors.length > ERROR_WINDOW) this.errors.shift()
    const count = this.errors.filter((entry) => entry === key).length
    return ERROR_NOTE_AT.has(count)
      ? `This same error has now come back ${count} times, so what you have tried so far does not address its cause. Read the error again and find what it actually says is wrong, rather than trying a variation of the same fix.`
      : undefined
  }

  private sameFile(name: string, input: unknown, isError: boolean): string | undefined {
    if (name !== 'read_file' || isError) return undefined
    const path = (input as { path?: unknown } | null)?.path
    if (typeof path !== 'string') return undefined
    const count = (this.reads.get(path) ?? 0) + 1
    this.reads.set(path, count)
    return count === SAME_FILE_READS
      ? `You have read ${path} ${count} times without changing anything. You have what it says: act on it, or look somewhere else.`
      : undefined
  }

  private alternating(name: string, input: unknown, edits: number): string | undefined {
    this.calls.push({ signature: `${name}:${canonicalInput(input)}`, edits })
    if (this.calls.length > ALTERNATION_LENGTH) this.calls.shift()
    if (this.calls.length < ALTERNATION_LENGTH) return undefined
    const [a, b] = this.calls
    if (a!.signature === b!.signature) return undefined
    const taking = this.calls.every((call, index) => call.signature === (index % 2 === 0 ? a! : b!).signature)
    if (!taking) return undefined
    this.calls.length = 0
    return 'You have been alternating between the same two actions without getting anywhere. Neither is going to change the result: try something different.'
  }

  private escalated(note: string): string {
    this.notes++
    return this.notes > 1
      ? `${note} This is not the first time in this turn. Before your next tool call, write down what you have learned and a different plan.`
      : note
  }
}
