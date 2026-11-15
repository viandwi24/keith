import { bannerOf, type RoomBanner } from '@keith/app-model'
import { ROOM_EVENT, type RoomInvite, type RoomListItem } from '@keith/contracts'
import { getClient, session } from '../session/index.ts'
import { toasts } from '../toasts/index.ts'
import { DECLINED_TEXT, pendingInvitesOf } from './rooms-view.ts'

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const CLOCK_MS = 30_000

/** The record types that say a room changed: the transcript's `room.event` and the core's `brain.corpus-callosum.*` lines. */
const isRoomRecord = (type: string): boolean =>
  type === ROOM_EVENT || type.startsWith('brain.corpus-callosum.')

/**
 * The person's rooms, app wide (the Home banner and invitation, the Rooms page): `rooms.list` at start, on every room record and on
 * every resync (the feed sends no history). The invitation toast shows once per room, when the invitation first appears.
 */
class RoomsState {
  headers = $state.raw<readonly RoomListItem[]>([])
  loaded = $state(false)
  error = $state<string | undefined>(undefined)
  /** The clock of the invitation expiry (epoch ms). */
  now = $state(Date.now())
  busy = $state<string[]>([])

  private offs: (() => void)[] = []
  private timer: ReturnType<typeof setInterval> | undefined
  private seen = new Set<string>()

  private get me(): string {
    return session.me?.personId ?? ''
  }

  banner: RoomBanner | undefined = $derived(bannerOf(this.headers, this.me))
  invites: RoomInvite[] = $derived(pendingInvitesOf(this.headers, this.me, this.now))

  start(): void {
    if (this.offs.length > 0) return
    const feed = getClient().feed()
    this.offs.push(
      feed.subscribeEvents((record) => {
        if (isRoomRecord(record.type)) this.reload()
      }),
      feed.subscribeResync(() => this.reload()),
    )
    this.timer = setInterval(() => {
      this.now = Date.now()
    }, CLOCK_MS)
    this.reload()
  }

  stop(): void {
    for (const off of this.offs) off()
    this.offs = []
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    this.headers = []
    this.loaded = false
    this.seen.clear()
  }

  reload(): void {
    if (session.me === undefined) return
    void getClient()
      .rooms.list({})
      .then(
        (answer) => {
          this.error = undefined
          this.loaded = true
          this.now = Date.now()
          this.headers = answer.rooms
          this.announce()
        },
        (e: unknown) => {
          this.loaded = true
          this.error = `Failed to load rooms: ${messageOf(e)}`
        },
      )
  }

  private announce(): void {
    for (const invite of this.invites) {
      if (this.seen.has(invite.roomId)) continue
      this.seen.add(invite.roomId)
      toasts.push(`${invite.initiator.name} invites you to a room with Keith.`, { level: 'info' })
    }
  }

  private async run(id: string, act: () => Promise<unknown>, done?: () => void): Promise<boolean> {
    if (this.busy.includes(id)) return false
    this.busy = [...this.busy, id]
    try {
      await act()
      done?.()
      return true
    } catch (e) {
      toasts.push(messageOf(e), { level: 'error' })
      return false
    } finally {
      this.busy = this.busy.filter((x) => x !== id)
      this.reload()
    }
  }

  /** Accept an invitation; true when the room is joined (the caller opens it). */
  accept = (roomId: string): Promise<boolean> =>
    this.run(roomId, () => getClient().rooms.accept({ roomId }))

  decline = (roomId: string): Promise<boolean> =>
    this.run(
      roomId,
      () => getClient().rooms.decline({ roomId }),
      () => toasts.push(DECLINED_TEXT, { level: 'info' }),
    )

  /** Start a room with the people named; the new room's id, or undefined after a refusal (its words are a toast). */
  async create(invite: string[], name: string | undefined): Promise<string | undefined> {
    try {
      const view = await getClient().rooms.start({
        invite,
        ...(name === undefined ? {} : { name }),
      })
      this.reload()
      return view.room.id
    } catch (e) {
      toasts.push(messageOf(e), { level: 'error' })
      return undefined
    }
  }
}

export const rooms = new RoomsState()
