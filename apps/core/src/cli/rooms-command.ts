// `keith-core rooms` (docs/specs/corpus-callosum.md "CLI and TUI", core-cli.md, cli.md). `list` and `show` read the room headers
// straight from the database, read only, so they work with core stopped and never touch the socket; they print no transcript
// text (the audited owner read is `rooms.events` in the TUI). `end` goes through the running core (`rooms.end`), which checks
// the control rule and writes the audit rows (`room.end`, and `room.owner-end` when the owner did not start the room).
// The data folder is the owner's: whoever runs this on the machine is the owner, as with `config show`.
import {
  CliError,
  type Command,
  defineCommand,
  printTable,
  stripControl,
  UsageError,
} from '@keith/cli'
import { ROOM_LIST_LIMIT_MAX } from '@keith/contracts'
import { type MemberRecord, type RoomRecord, roomsRepo, type Sqlite } from '@keith/db'
import { dbState, openKeithDatabaseReadOnly, refusalOf } from '../platform/db.ts'
import { type CliDeps, configOf, connectLocal } from './context.ts'
import { askFirst, yesFlag } from './prompt-helpers.ts'

const LIST_DEFAULT_LIMIT = 50
const NOT_FOUND = 'there is no such room'

const isoOf = (ms: number | null): string => (ms === null ? '-' : new Date(ms).toISOString())

/** Names of the people by id, read from the directory; a person the directory no longer has keeps their id. */
function nameLookup(sqlite: Sqlite): (id: string) => string {
  const byId = sqlite.query<{ name: string }, [string]>('SELECT name FROM people WHERE id = ?')
  return (id) => {
    const row = byId.get(id)
    return row === null ? id : stripControl(row.name)
  }
}

/** The active members' names, then `(+ n invited)`: the members column of `list`. */
export function membersColumn(
  members: readonly MemberRecord[],
  name: (id: string) => string,
): string {
  const active = members.filter((m) => m.status === 'active').map((m) => name(m.personId))
  const invited = members.filter((m) => m.status === 'invited').length
  const names = active.length === 0 ? '-' : active.join(', ')
  return invited === 0 ? names : `${names} (+ ${invited} invited)`
}

/** The header of one room, one fact per line, no transcript text. */
export function roomHeaderLines(room: RoomRecord, name: (id: string) => string): string[] {
  const lines = [
    `id: ${room.id}`,
    `name: ${stripControl(room.name)}`,
    `state: ${room.state}`,
    `initiator: ${name(room.initiator)}`,
    `created: ${isoOf(room.createdAt)}`,
    `started: ${isoOf(room.startedAt)}`,
  ]
  if (room.state === 'ended') {
    const by = room.endedBy === null ? '-' : name(room.endedBy)
    const reason = room.endReason === null ? '' : `, reason: ${stripControl(room.endReason)}`
    lines.push(`ended: ${isoOf(room.endedAt)} by ${by}${reason}`)
  }
  return lines
}

/**
 * Runs `use` on the database read only. Refuses, with the reason, when the folder has no database, the database is behind,
 * ahead or unreadable; it never migrates and never writes.
 */
async function withRooms<T>(deps: CliDeps, use: (sqlite: Sqlite) => T): Promise<T> {
  const config = configOf(deps)
  const state = dbState(config.dbFile)
  if (state.kind === 'missing')
    throw new CliError('this data folder is not set up: run `keith-core setup`')
  const refusal = refusalOf(state, config)
  if (refusal !== undefined) throw new CliError(refusal)
  if (state.kind !== 'ready')
    throw new CliError('the database is behind: run `keith-core db migrate`')
  const sqlite = await openKeithDatabaseReadOnly(config.dbFile)
  try {
    return use(sqlite)
  } finally {
    sqlite.close()
  }
}

/** The one id a verb takes; the usage line names the verb. */
function idOf(positionals: readonly string[], usage: string): string {
  const [id] = positionals
  if (positionals.length !== 1 || id === undefined || id === '') throw new UsageError(usage)
  return id
}

/** A flag that must be a whole number. */
function wholeNumber(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined
  if (!/^\d+$/.test(raw)) throw new UsageError(`--${flag} takes a whole number`)
  return Number(raw)
}

function listCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'list',
    summary: 'Every room with its state and members (headers only, no transcript; works offline)',
    usage: 'list [--limit <n>]',
    flags: {
      limit: {
        type: 'string',
        placeholder: 'n',
        description: `Rooms to show, 1 to ${ROOM_LIST_LIMIT_MAX}, newest first (default ${LIST_DEFAULT_LIMIT})`,
      },
    },
    run: async (ctx) => {
      const limit = wholeNumber(ctx.string('limit'), 'limit') ?? LIST_DEFAULT_LIMIT
      if (limit < 1 || limit > ROOM_LIST_LIMIT_MAX)
        throw new UsageError(`--limit takes 1 to ${ROOM_LIST_LIMIT_MAX}`)
      const rows = await withRooms(deps, (sqlite) => {
        const rooms = roomsRepo(sqlite)
        const name = nameLookup(sqlite)
        return rooms
          .list(limit)
          .map((room) => [
            room.id,
            room.state,
            stripControl(room.name),
            membersColumn(rooms.members(room.id), name),
          ])
      })
      if (rows.length === 0) ctx.io.stdout.write('no rooms\n')
      else printTable(ctx.io, rows, { header: ['ID', 'STATE', 'NAME', 'MEMBERS'] })
      return 0
    },
  })
}

function showCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'show',
    summary: 'One room: its header and the people in it with their status (no transcript)',
    usage: 'show <id>',
    positionals: true,
    run: async (ctx) => {
      const id = idOf(ctx.positionals, 'usage: rooms show <id>')
      const view = await withRooms(deps, (sqlite) => {
        const rooms = roomsRepo(sqlite)
        const room = rooms.get(id)
        if (room === undefined) throw new CliError(NOT_FOUND)
        const name = nameLookup(sqlite)
        const members = rooms.members(room.id).map((m) => ({
          name: name(m.personId),
          status: m.status,
          since: m.joinedAt ?? m.invitedAt,
          left: m.leftAt,
        }))
        return { header: roomHeaderLines(room, name), members }
      })
      for (const line of view.header) ctx.io.stdout.write(`${line}\n`)
      if (view.members.length === 0) {
        ctx.io.stdout.write('members: none\n')
        return 0
      }
      ctx.io.stdout.write('members:\n')
      printTable(
        ctx.io,
        view.members.map((m) => [`  ${m.name}`, m.status, isoOf(m.since), isoOf(m.left)]),
        { header: ['  NAME', 'STATUS', 'SINCE', 'LEFT'] },
      )
      return 0
    },
  })
}

function endCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'end',
    summary: 'End a room through the running core (owner; audited as room.end and room.owner-end)',
    usage: 'end <id> [--reason <text>] [--yes]',
    positionals: true,
    flags: {
      reason: {
        type: 'string',
        placeholder: 'text',
        description: 'Why the room ends; the members are told (up to 200 characters)',
      },
      ...yesFlag,
    },
    run: async (ctx) => {
      const id = idOf(ctx.positionals, 'usage: rooms end <id> [--reason <text>] [--yes]')
      const reason = ctx.string('reason')
      await askFirst(
        ctx.io,
        'rooms end',
        `end room ${stripControl(id)}? The members are told.`,
        ctx.bool('yes'),
      )
      const { client } = await connectLocal(deps)
      await client.rpc.rooms.end(reason === undefined ? { roomId: id } : { roomId: id, reason })
      const note = reason === undefined ? '' : `: ${stripControl(reason)}`
      ctx.io.stdout.write(`room ${id} ended${note}\n`)
      return 0
    },
  })
}

/** `keith-core rooms list|show|end`: the owner's view of the shared rooms (docs/specs/corpus-callosum.md). */
export function roomsCommand(deps: CliDeps): Command {
  return defineCommand({
    name: 'rooms',
    summary: 'Shared rooms: list them, show one, or end one (owner)',
    subcommands: [listCommand(deps), showCommand(deps), endCommand(deps)],
  })
}
