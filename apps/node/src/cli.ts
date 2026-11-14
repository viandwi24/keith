import { type CliIo, processIo, runCli } from '@keith/cli'
import pkg from '../package.json' with { type: 'json' }
import { nodeCommands } from './commands.ts'

/** Run the CLI; returns the process exit code. `io` is injectable for tests. */
export function main(
  argv: string[],
  signal?: AbortSignal,
  io: CliIo = processIo(),
): Promise<number> {
  return runCli({
    program: 'keith-node',
    version: pkg.version,
    summary: 'Peripheral node daemon: pair with a Keith core and run its commands.',
    commands: nodeCommands(signal),
    argv,
    io,
  })
}
