import { type RoomViewState, roomViewOf } from '@keith/app-model'
import {
  createRoomEvents,
  createRoomView,
  type RoomEvents,
  type RoomViewStore,
} from '@keith/client/browser'
import { getClient } from '../session/index.ts'
import { toasts } from '../toasts/index.ts'

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const CLOCK_MS = 5000

/**
 * One room for the room page: the header, members, presence, indicator and confirmations from `rooms.get` (`createRoomView`), the
 * transcript from `rooms.events` (`createRoomEvents`), both kept in step with the activity feed. Actions call `client.rooms`.
 */
export class RoomController {
  state = $state.raw<RoomViewState | undefined>(undefined)
  /** A failed read (the page keeps what it had). */
  error = $state<string | undefined>(undefined)
  /** A failed action, under the composer. */
  note = $state<string | undefined>(undefined)
  draft = $state('')
  sending = $state(false)
  answering = $state(false)

  private events: RoomEvents | undefined
  private view: RoomViewStore | undefined
  private offs: (() => void)[] = []
  private timer: ReturnType<typeof setInterval> | undefined

  readonly roomId: string
  private readonly me: string

  constructor(roomId: string, me: string) {
    this.roomId = roomId
    this.me = me
  }

  start(): void {
    if (this.events !== undefined) return
    const client = getClient()
    const feed = client.feed()
    const events = createRoomEvents({ roomId: this.roomId, events: client.rooms.events, feed })
    const view = createRoomView({
      roomId: this.roomId,
      get: (input) => client.rooms.get(input),
      feed,
    })
    this.events = events
    this.view = view
    this.offs.push(
      events.subscribe(() => this.sync()),
      view.subscribe(() => this.sync()),
      view.attach(),
      events.attach(),
      // the brain's room lines (a turn, a join) also change what the view shows
      feed.subscribeEvents((record) => {
        const payload = record.payload as { roomId?: unknown } | null
        if (record.type.startsWith('brain.corpus-callosum.') && payload?.roomId === this.roomId)
          void view.refresh()
      }),
    )
    // a confirmation request that passes its expiry leaves the screen without another event
    this.timer = setInterval(() => this.sync(), CLOCK_MS)
    this.sync()
  }

  stop(): void {
    for (const off of this.offs) off()
    this.offs = []
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    this.events = undefined
    this.view = undefined
  }

  private sync(): void {
    const events = this.events
    const view = this.view
    if (events === undefined || view === undefined) return
    const transcript = events.get()
    const snapshot = view.get()
    this.state =
      snapshot.view === undefined
        ? undefined
        : roomViewOf({
            view: snapshot.view,
            events: transcript.events,
            me: this.me,
            now: Date.now(),
          })
    this.error =
      snapshot.error !== undefined
        ? `Failed to load the room: ${messageOf(snapshot.error)}`
        : transcript.error !== undefined
          ? `Failed to read the transcript: ${messageOf(transcript.error)}`
          : undefined
  }

  /** Send the draft; on a refusal the text stays in the field. */
  async send(): Promise<void> {
    const text = this.draft.trim()
    if (text === '' || this.sending) return
    const replyToKeith = this.state?.transcript.at(-1)?.keith === true
    this.sending = true
    this.note = undefined
    try {
      await getClient().rooms.say({ roomId: this.roomId, text, replyToKeith })
      this.draft = ''
    } catch (e) {
      this.note = `Failed to send: ${messageOf(e)}`
    } finally {
      this.sending = false
    }
  }

  async answer(requestId: string, approved: boolean): Promise<void> {
    if (this.answering) return
    this.answering = true
    this.note = undefined
    try {
      await getClient().rooms.confirm({ requestId, approved })
      await this.view?.refresh()
    } catch (e) {
      this.note = `Failed to answer: ${messageOf(e)}`
    } finally {
      this.answering = false
    }
  }

  /** Run a room call (leave, end, invite, remove) with its toast; the view is read again after. */
  async run(act: () => Promise<unknown>, done: string): Promise<void> {
    this.note = undefined
    try {
      await act()
      toasts.push(done, { level: 'success' })
      await this.view?.refresh()
    } catch (e) {
      this.note = messageOf(e)
    }
  }

  leave = (): Promise<void> =>
    this.run(() => getClient().rooms.leave({ roomId: this.roomId }), 'You left the room.')
  end = (): Promise<void> =>
    this.run(() => getClient().rooms.end({ roomId: this.roomId }), 'The room ended.')
  invite = (people: string[]): Promise<void> =>
    this.run(
      () => getClient().rooms.invite({ roomId: this.roomId, invite: people }),
      `Invited ${people.join(', ')}.`,
    )
  remove = (person: string): Promise<void> =>
    this.run(() => getClient().rooms.remove({ roomId: this.roomId, person }), `Removed ${person}.`)
}
