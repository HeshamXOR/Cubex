/**
 * Spots a model that keeps making the same tool call within one turn.
 *
 * Two thresholds, both on identical calls (same tool name, deeply equal input regardless of key order):
 * the third call in a row gets a note telling the model to change approach, and when five of the last
 * ten calls are one identical call, the turn should stop. The guard only counts; the caller decides
 * what to do with the answer.
 */

export interface RepeatVerdict {
  /** Appended to this call's result: the model repeated an identical call. */
  note?: string
  /** Why the turn should end, e.g. "Stopped: the agent made the same read_file call 5 times." */
  stop?: string
}

export interface RepeatGuardOptions {
  /** Identical calls in a row that earn a note. Default 3. */
  noteAfter?: number
  /** How many recent calls the stop rule looks at. Default 10. */
  window?: number
  /** Identical calls within that window that end the turn. Default 5. */
  stopAfter?: number
}

/** Key order must not let an identical call evade the guard. */
export function canonicalInput(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  }) ?? 'null'
}

export class RepeatGuard {
  private readonly recent: string[] = []
  private streak = 0
  private readonly noteAfter: number
  private readonly window: number
  private readonly stopAfter: number

  constructor(options: RepeatGuardOptions = {}) {
    this.noteAfter = options.noteAfter ?? 3
    this.window = options.window ?? 10
    this.stopAfter = options.stopAfter ?? 5
  }

  /**
   * Record the next call of the turn, in the order the model made them. `edits` counts the file changes made so far
   * in the turn: the same call after an edit (run the tests, edit, run them again) is new work, not a repeat.
   */
  record(name: string, input: unknown, edits = 0): RepeatVerdict {
    const signature = `${name}:${edits}:${canonicalInput(input)}`
    this.streak = this.recent[this.recent.length - 1] === signature ? this.streak + 1 : 1
    this.recent.push(signature)
    if (this.recent.length > this.window) this.recent.shift()

    const inWindow = this.recent.filter((entry) => entry === signature).length
    if (inWindow >= this.stopAfter) {
      return { stop: `Stopped: the agent made the same ${name} call ${inWindow} times.` }
    }
    if (this.streak >= this.noteAfter) {
      return {
        note: `Note: this is the same ${name} call with identical input, made ${this.streak} times in a row. ` +
          'Repeating it will not give a different result. Change your approach, or report what is blocking you.'
      }
    }
    return {}
  }

  /** A human review starts fresh work, so earlier calls no longer count. */
  reset(): void {
    this.recent.length = 0
    this.streak = 0
  }
}
