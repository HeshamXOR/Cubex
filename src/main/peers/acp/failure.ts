/** Why an agent could not be used, in a sentence for the person, with what to try and what the program itself printed. */
export class AcpFailure extends Error {
  readonly hint: string | undefined
  readonly output: string | undefined

  constructor(message: string, extra: { hint?: string; output?: string } = {}) {
    super(message)
    this.name = 'AcpFailure'
    this.hint = extra.hint
    this.output = extra.output
  }
}
