/** A command was used wrongly (missing or unknown flag, bad value). `runCli` exits with 2. */
export class UsageError extends Error {
  override readonly name = 'UsageError'
  /** Command path whose `--help` the error points to (default: the resolved command). */
  readonly path: string[] | undefined
  constructor(message: string, path?: string[]) {
    super(message)
    this.path = path
  }
}

/** A runtime failure with a chosen exit code (default 1); the message is printed as one line. */
export class CliError extends Error {
  override readonly name = 'CliError'
  readonly exitCode: number
  constructor(message: string, exitCode = 1) {
    super(message)
    this.exitCode = exitCode
  }
}

/** The user pressed Ctrl+C during a prompt. `runCli` exits with 130. */
export class PromptCancelled extends Error {
  override readonly name = 'PromptCancelled'
  constructor() {
    super('cancelled')
  }
}
