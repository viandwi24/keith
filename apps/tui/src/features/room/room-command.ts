import type { RoomsApi } from '@keith/client'
import type { ToastLevel } from '@keith/ui'
import type { LocalAsk } from './room-screen.tsx'

/** The `/room` forms (tui.md, "Commands and keys"). A usage error is a `usage` command with the line to show. */
export type RoomCommand =
  | { kind: 'open' }
  | { kind: 'start'; invite: string[] }
  | { kind: 'invite'; person: string }
  | { kind: 'leave' }
  | { kind: 'remove'; person: string }
  | { kind: 'end' }
  | { kind: 'usage'; text: string }

export const ROOM_USAGE =
  'Usage: /room · /room start <user> [<user>…] · /room invite <user> · /room leave · /room remove <user> · /room end'

const usage = (text: string): RoomCommand => ({ kind: 'usage', text })

/** The words after `/room`: `start ana duta`, `invite ana`, `leave`, `remove duta`, `end`, or nothing (open). */
export function parseRoomCommand(args: string): RoomCommand {
  const words = args
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '')
  const sub = words[0]
  const rest = words.slice(1)
  const person = rest[0]
  if (sub === undefined) return { kind: 'open' }
  if (sub === 'start')
    return rest.length > 0
      ? { kind: 'start', invite: rest }
      : usage('Usage: /room start <user> [<user>…]')
  if (sub === 'invite')
    return person !== undefined && rest.length === 1
      ? { kind: 'invite', person }
      : usage('Usage: /room invite <user>')
  if (sub === 'remove')
    return person !== undefined && rest.length === 1
      ? { kind: 'remove', person }
      : usage('Usage: /room remove <user>')
  if (sub === 'leave') return rest.length === 0 ? { kind: 'leave' } : usage('Usage: /room leave')
  if (sub === 'end') return rest.length === 0 ? { kind: 'end' } : usage('Usage: /room end')
  return usage(ROOM_USAGE)
}

/** What a `/room` command reads and does: the room it acts on, the screen, the toasts, the calls. */
export interface RoomCommandEnv {
  /** The active room of the person, if they are in one. */
  active: { roomId: string; name: string } | undefined
  /** An invitation waits for the person (Home shows it). */
  invited: boolean
  rooms: RoomsApi
  say(level: 'info' | 'warning', rows: readonly string[]): void
  toast(text: string, level: ToastLevel): void
  /** Open the room view; `ask` is a confirmation the bar shows at once. */
  open(roomId: string, ask?: LocalAsk): void
  goHome(): void
  /** Read the room lists again (the banner follows the change). */
  reload(): void
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Runs a `/room` command. `/room` opens the active room, or Home when only invitations wait. `start` opens the new room;
 * `invite` and `leave` need an active room. `remove` and `end` open the room view with a y/n confirmation in the bar before the
 * call (a direct command is the person's own act, but it is still asked). A refused call is an error toast with the core's words.
 */
export function runRoomCommand(command: RoomCommand, env: RoomCommandEnv): void {
  const { active, rooms } = env
  const failed = (e: unknown): void => env.toast(messageOf(e), 'error')
  switch (command.kind) {
    case 'usage':
      env.say('info', [command.text])
      return
    case 'open':
      if (active !== undefined) env.open(active.roomId)
      else if (env.invited) env.goHome()
      else env.say('info', ['You are not in a room. /room start <user> starts one with Keith.'])
      return
    case 'start':
      void rooms.start({ invite: command.invite }).then((view) => {
        env.reload()
        env.open(view.room.id)
      }, failed)
      return
    default:
      break
  }
  if (active === undefined) {
    env.say('info', ['You are not in a room.'])
    return
  }
  const { roomId, name } = active
  switch (command.kind) {
    case 'invite':
      void rooms.invite({ roomId, invite: [command.person] }).then(() => {
        env.reload()
        env.toast(`Invited ${command.person}.`, 'success')
      }, failed)
      return
    case 'leave':
      void rooms.leave({ roomId }).then(() => {
        env.reload()
        env.toast('You left the room.', 'info')
      }, failed)
      return
    case 'remove':
      env.open(roomId, {
        question: `Remove ${command.person} from the room?`,
        run: () =>
          rooms.remove({ roomId, person: command.person }).then(() => {
            env.reload()
            env.toast(`Removed ${command.person}.`, 'success')
          }, failed),
      })
      return
    case 'end':
      env.open(roomId, {
        question: `End the room "${name}"?`,
        run: () =>
          rooms.end({ roomId }).then(() => {
            env.reload()
            env.toast('The room ended.', 'info')
          }, failed),
      })
      return
    default:
      return
  }
}
