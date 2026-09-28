// `keith person …`: the owner brings people into Keith from the host (phase 5). See
// docs/architecture/nodes.md#adding-people and ADR-0017 / ADR-0018. Placeholder: P5-A1 implements
// every subcommand behind `runPersonCommand`, keeping this signature and the usage text.

import type { Clock } from '../shared/types.ts'
import type { Prompter } from './prompt.ts'

/** What `keith person` needs from the CLI (a subset of `CliIo`). */
export type PersonCommandIo = {
  env: Record<string, string | undefined>
  out: (line: string) => void
  err: (line: string) => void
  /** Only `remove` asks (its confirmation). Default: the terminal. */
  prompter?: Prompter | undefined
  clock?: Clock | undefined
}

export const PERSON_SUBCOMMANDS = [
  'add',
  'list',
  'invite',
  'tier',
  'card',
  'block',
  'unblock',
  'remove',
] as const
export type PersonSubcommand = (typeof PERSON_SUBCOMMANDS)[number]

export const PERSON_USAGE = `Usage: keith person <command> [options]

Commands:
  add <name> [--tier member|guest]     Create the person, their relationship card and main
                                       thread, and print an invite link (default tier: member)
  list                                 List people: name, tier, username, sign-in, last seen
  invite <name>                        Print a new invite link; revokes older unused ones
  tier <name> <member|guest>           Change a person's tier (never the owner's)
  card <name> [--tone <text>] [--notes <text>]
                                       Show or edit the relationship card
  block <name> --from <other>          Refuse relays from <other> to <name>
  unblock <name> --from <other>        Accept relays from <other> to <name> again
  remove <name> [--yes]                Delete the person and their data (ADR-0018); needs
                                       Keith stopped. Run keith backup first

An invite link is <publicUrl>/#invite=<code> (server.publicUrl, default http://<host>:<port>).
It works once and expires after auth.inviteTtlHours. In the terminal: keith-tui --invite <code>.`

function isSubcommand(value: string): value is PersonSubcommand {
  return (PERSON_SUBCOMMANDS as readonly string[]).includes(value)
}

/** Runs `keith person <args>`. Returns the process exit code. */
export async function runPersonCommand(args: string[], io: PersonCommandIo): Promise<number> {
  const [sub] = args
  if (sub === undefined || sub === '--help' || sub === '-h' || sub === 'help') {
    io.out(PERSON_USAGE)
    return 0
  }
  if (!isSubcommand(sub)) {
    io.err(`Unknown person command: ${sub}`)
    io.err(PERSON_USAGE)
    return 2
  }
  io.err(`keith person ${sub} is not implemented yet (P5-A1)`)
  return 1
}
