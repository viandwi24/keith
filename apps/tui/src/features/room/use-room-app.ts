import type { KeithClient } from '@keith/client'
import type { ToastLevel } from '@keith/ui'
import { useCallback, useEffect, useRef, useState } from 'react'
import { parseRoomCommand, runRoomCommand } from './room-command.ts'
import type { LocalAsk } from './room-screen.tsx'
import { activeRoomOf, type InviteNotice, type RoomBanner } from './room-state.ts'
import { type Rooms, useRooms } from './use-room.ts'

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The room view's target: the room, and a confirmation the bar shows at once (`/room end`, `/room remove`). */
export interface RoomTarget {
  roomId: string
  ask: LocalAsk | undefined
}

export interface RoomApp {
  rooms: Rooms
  /** The banner row of Home and the chat, or undefined. */
  banner: RoomBanner | undefined
  /** The invitation to accept or decline, or undefined. */
  invite: InviteNotice | undefined
  /** What the room view shows, once it was opened. */
  target: RoomTarget | undefined
  /** Open the room view on a room (the app switches to the screen). */
  open(roomId: string, ask?: LocalAsk): void
  /** A `/room …` line typed in the chat. */
  command(args: string): void
  accept(): void
  decline(): void
}

export interface RoomAppOptions {
  client: KeithClient
  /** The signed-in person's id; undefined while signed out or not yet known (nothing is read). */
  me: string | undefined
  toast(text: string, level: ToastLevel): void
  say(level: 'info' | 'warning', rows: readonly string[]): void
  /** Switch the app to the room screen. */
  showRoom(): void
  /** Switch the app to Home. */
  goHome(): void
}

/**
 * The rooms of the app: the lists (`useRooms`), the banner and the invitation, the room view's target, the `/room` command, and the
 * accept and decline of an invitation. The invitation toast shows once per room, when the invitation first appears.
 */
export function useRoomApp({ client, me, toast, say, showRoom, goHome }: RoomAppOptions): RoomApp {
  const rooms = useRooms(client, me)
  const [target, setTarget] = useState<RoomTarget | undefined>()
  const open = useCallback(
    (roomId: string, ask?: LocalAsk) => {
      setTarget({ roomId, ask })
      showRoom()
    },
    [showRoom],
  )
  const seen = useRef(new Set<string>())
  const invite = rooms.invite
  useEffect(() => {
    const roomId = invite?.invite.roomId
    if (invite === undefined || roomId === undefined || seen.current.has(roomId)) return
    seen.current.add(roomId)
    toast(`${invite.invite.initiator.name} invites you to a room with Keith.`, 'info')
  }, [invite, toast])

  const command = (args: string) => {
    const parsed = parseRoomCommand(args)
    runRoomCommand(parsed, {
      active: activeRoomOf(rooms.headers, me ?? ''),
      invited: invite !== undefined,
      rooms: client.rooms,
      say,
      toast,
      open,
      goHome,
      reload: rooms.reload,
    })
  }
  const accept = () => {
    const pending = invite?.invite
    if (pending === undefined) return
    client.rooms.accept({ roomId: pending.roomId }).then(
      () => {
        rooms.reload()
        open(pending.roomId)
      },
      (e: unknown) => toast(messageOf(e), 'error'),
    )
  }
  const decline = () => {
    const pending = invite?.invite
    if (pending === undefined) return
    client.rooms.decline({ roomId: pending.roomId }).then(
      () => {
        rooms.reload()
        toast('Declined.', 'info')
      },
      (e: unknown) => toast(messageOf(e), 'error'),
    )
  }
  return {
    rooms,
    banner: rooms.banner,
    invite,
    target,
    open,
    command,
    accept,
    decline,
  }
}
