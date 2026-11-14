// The room context (docs/specs/corpus-callosum.md "Window and context", ADR-0026 §4, ADR-0025 §4): the volatile reminder that gives the
// room agent its window. `step.prepare` returns it; a reminder never enters the stored history or the system prompt (the pattern of
// modules/tasks/reminder.ts). Nothing else enters: no memory, no agenda, no personal note, no personal resource, no other room.
import type { ClientRecord } from '@keith/contracts'
import type { EventRecord, MemberRecord, RoomRecord, RoomsRepo } from '@keith/db'
import { definePlugin, type HarnessPlugin } from 'eharness'
import { modeForClients, modeText, renderAddressLine } from '../prefrontal/index.ts'

export const ROOM_CONTEXT_PLUGIN = 'keith-room-context'

/** What the parietal disclosure rule releases of `subject` to `viewer`: `line` is null when nothing is shared. */
export type DisclosedFor = (viewer: string, subject: string) => Promise<{ line: string | null }>

/** One entry of the room folder listing (top level only, as `listRoomFiles` gives it). */
export interface WorkspaceEntry {
  name: string
  dir: boolean
  size: number
}

export interface RoomContextDeps {
  rooms: Pick<RoomsRepo, 'get' | 'member' | 'members' | 'window'>
  /** The presence disclosure rule (parietal), viewed as the current speaker. */
  disclosedFor: DisclosedFor
  /** The top-level entries of `rooms/<roomId>/`, or undefined when the folder does not exist. */
  listWorkspace: (roomId: string) => WorkspaceEntry[] | undefined
  /** The clock (ms since the epoch). */
  now: () => number
  /** The display name of a person id (`keith` and `system` are named by the caller of this module). Read once per reminder. */
  name: (personId: string) => string | Promise<string>
  /**
   * The persona block (`prefrontal`): the same text for every speaker, read at each reminder, so an owner's change reaches the
   * next turn (P33.3.3). Absent: no persona block in the reminder.
   */
  persona?: () => string
  /**
   * The speaker's own `address` (their style, `prefrontal`). Called with the speaker's id only; undefined means the profile name
   * is used. No other person's value is read here.
   */
  addressOf?: (speaker: string) => string | undefined
  /**
   * The speaker's own clients (`parietal`, read only): the room's mode block comes from the speaker's channel (P33.4.1). Called
   * with the speaker's id only; absent: the plain chat block.
   */
  clientsOf?: (speaker: string) => readonly ClientRecord[]
}

/**
 * The mode block of the room reminder (P33.4.1, ADR-0029 §5): chosen in code from the speaker's own clients (their channel
 * and second screen). A speaker with no declared channel gets the plain chat block. Rooms never get a report mode here.
 */
export function roomModeLine(clients: readonly ClientRecord[] = []): string {
  return modeText(modeForClients(clients, 'chat'))
}

const ROOM_SESSION = /^room:(.+):g\d+$/
const KEITH = 'keith'

/** The room id of a room session (`room:<roomId>:g<n>`), or undefined for any other session. */
export function roomIdOfSession(sessionId: string): string | undefined {
  return ROOM_SESSION.exec(sessionId)?.[1]
}

/**
 * Neutralises speaker text before it enters the reminder: a line that begins with `[` gets a leading space (the rule
 * `eharness/group` uses for speaker lines), the newlines are flattened to spaces so no text can start a reminder line, and
 * every `<` becomes `&lt;` so no tag, `<system-reminder>` included, can be written into the block.
 */
export function neutralize(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => (line.startsWith('[') ? ` ${line}` : line))
    .join(' ')
    .replaceAll('<', '&lt;')
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** `HH:MM` in the server's local time. */
export function clockOf(at: number): string {
  const d = new Date(at)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function speakerName(event: EventRecord, name: (personId: string) => string): string {
  if (event.speaker === null) return 'system'
  if (event.speaker === KEITH) return 'Keith'
  return neutralize(name(event.speaker))
}

/** One window event: `[HH:MM] Name: text`; an event without text (join, leave, end) reads as `(kind)`. */
function eventLine(event: EventRecord, name: (personId: string) => string): string {
  const text = event.text === null ? `(${event.kind})` : neutralize(event.text)
  return `[${clockOf(event.at)}] ${speakerName(event, name)}: ${text}`
}

async function membersBlock(
  members: MemberRecord[],
  speaker: string,
  disclosedFor: DisclosedFor,
  name: (personId: string) => string,
): Promise<string> {
  const lines = await Promise.all(
    members.map(async (m) => {
      const released = await disclosedFor(speaker, m.personId)
      const shown = released.line === null ? 'not shared' : neutralize(released.line)
      return `- ${neutralize(name(m.personId))}: ${shown}`
    }),
  )
  return ['Members:', ...lines].join('\n')
}

function workspaceBlock(room: RoomRecord, entries: WorkspaceEntry[] | undefined): string {
  const head = `Workspace rooms/${room.id}/:`
  if (entries === undefined || entries.length === 0) return `${head} empty`
  const lines = entries.map((e) =>
    e.dir ? `- ${neutralize(e.name)}/` : `- ${neutralize(e.name)} (${e.size} bytes)`,
  )
  return [head, ...lines].join('\n')
}

/**
 * The reminder text of one room turn (internal; tested through the plugin). `speaker` is the person whose turn it is: the
 * presence lines are the ones the rule releases to that speaker.
 */
export async function renderRoomReminder(
  deps: RoomContextDeps,
  room: RoomRecord,
  speaker: string,
  members: MemberRecord[],
): Promise<string> {
  const now = deps.now()
  const events = deps.rooms.window(room.id, now)
  // the directory is async: the names this reminder shows are read once here, the rest of the block is synchronous
  const names = new Map<string, string>()
  const wanted = new Set([speaker, ...members.map((m) => m.personId)])
  for (const e of events) if (e.speaker !== null && e.speaker !== KEITH) wanted.add(e.speaker)
  for (const id of wanted) names.set(id, await deps.name(id))
  const name = (personId: string): string => names.get(personId) ?? personId
  const windowLines =
    events.length === 0 ? ['(no events in the window)'] : events.map((e) => eventLine(e, name))
  // the speaker's address only: the speaker's own style, or the profile name when none is set (P33.3.3)
  const address = renderAddressLine(deps.addressOf?.(speaker) ?? name(speaker))
  return [
    ...(deps.persona === undefined ? [] : [deps.persona()]),
    ...(address === undefined ? [] : [address]),
    roomModeLine(deps.clientsOf?.(speaker) ?? []),
    `Shared room "${neutralize(room.name)}". The person speaking now is ${neutralize(name(speaker))}.`,
    await membersBlock(members, speaker, deps.disclosedFor, name),
    workspaceBlock(room, deps.listWorkspace(room.id)),
    `Window: the last ${room.windowMinutes} minutes, at most ${room.windowEvents} events, oldest first:`,
    ...windowLines,
  ].join('\n')
}

/**
 * Plugin for the ROOM agent: `step.prepare` returns the volatile room reminder for the current speaker (`ctx.principal`). A
 * session that is not a room, a turn with no principal and a speaker who is not an active member get nothing at all.
 */
export function createRoomContext(
  deps: RoomContextDeps,
): HarnessPlugin<typeof ROOM_CONTEXT_PLUGIN> {
  return definePlugin({
    name: ROOM_CONTEXT_PLUGIN,
    setup: () => ({
      hooks: {
        'step.prepare': async (ctx) => {
          const roomId = roomIdOfSession(ctx.session.id)
          const speaker = ctx.principal?.id
          if (roomId === undefined || speaker === undefined) return
          const room = deps.rooms.get(roomId)
          if (room === undefined) return
          const me = deps.rooms.member(roomId, speaker)
          if (me?.status !== 'active') return
          const active = deps.rooms.members(roomId).filter((m) => m.status === 'active')
          return { reminder: await renderRoomReminder(deps, room, speaker, active) }
        },
      },
    }),
  })
}
