// Shared rooms on the client (docs/specs/corpus-callosum.md, "RPC"; docs/specs/client.md, "Rooms"). Two parts:
// `roomsApiOf` wraps the `rpc.rooms.*` procedures in one typed object, and `createRoomEvents` keeps one room's transcript
// in step with the activity feed. The controller is a plain store (get, subscribe), like `attention()`: a UI hook reads it.
import {
  ROOM_EVENT,
  ROOM_INDICATOR,
  type RoomEvent,
  RoomEventRecordSchema,
  RoomIndicatorRecordSchema,
  type RoomSettings,
  type RoomSettingsSet,
  type RoomsConfirmInput,
  type RoomsConfirmOutput,
  type RoomsEndInput,
  type RoomsEventsInput,
  type RoomsEventsOutput,
  type RoomsFilesInput,
  type RoomsFilesOutput,
  type RoomsInviteInput,
  type RoomsListInput,
  type RoomsListOutput,
  type RoomsOk,
  type RoomsRemoveInput,
  type RoomsSayInput,
  type RoomsSayOutput,
  type RoomsStartInput,
  type RoomView,
} from '@keith/contracts'
import type { KeithClient } from './client.ts'

/** Records per `rooms.events` call when the caller gives no `limit`. */
export const ROOM_EVENTS_PAGE = 200

/** The rooms API of one client: each method is one `rpc.rooms.*` procedure, typed by `@keith/contracts`. */
export interface RoomsApi {
  start(input: RoomsStartInput): Promise<RoomView>
  invite(input: RoomsInviteInput): Promise<RoomView>
  accept(input: { roomId: string }): Promise<RoomView>
  decline(input: { roomId: string }): Promise<RoomsOk>
  say(input: RoomsSayInput): Promise<RoomsSayOutput>
  leave(input: { roomId: string }): Promise<RoomsOk>
  remove(input: RoomsRemoveInput): Promise<RoomsOk>
  end(input: RoomsEndInput): Promise<RoomsOk>
  confirm(input: RoomsConfirmInput): Promise<RoomsConfirmOutput>
  get(input: { roomId: string }): Promise<RoomView>
  list(input?: RoomsListInput): Promise<RoomsListOutput>
  events(input: RoomsEventsInput): Promise<RoomsEventsOutput>
  files(input: RoomsFilesInput): Promise<RoomsFilesOutput>
  settings: {
    get(): Promise<RoomSettings>
    set(input: RoomSettingsSet): Promise<RoomSettings>
  }
}

/** The rooms API over a client's typed `rpc` (`client.rooms` is this for the client it was created with). */
export function roomsApiOf(client: Pick<KeithClient, 'rpc'>): RoomsApi {
  const { rooms } = client.rpc
  return {
    start: (input) => rooms.start(input),
    invite: (input) => rooms.invite(input),
    accept: (input) => rooms.accept(input),
    decline: (input) => rooms.decline(input),
    say: (input) => rooms.say(input),
    leave: (input) => rooms.leave(input),
    remove: (input) => rooms.remove(input),
    end: (input) => rooms.end(input),
    confirm: (input) => rooms.confirm(input),
    get: (input) => rooms.get(input),
    list: (input = {}) => rooms.list(input),
    events: (input) => rooms.events(input),
    files: (input) => rooms.files(input),
    settings: {
      get: () => rooms.settings.get(),
      set: (input) => rooms.settings.set(input),
    },
  }
}

/** The activity records the controller reads: any record with a type and a payload (`ActivityRecord` of eharness). */
export interface RoomFeedRecord {
  type: string
  payload: unknown
}

/** The part of the activity feed the controller uses (`client.feed()` satisfies it). */
export interface RoomEventsFeed {
  subscribeEvents(fn: (record: RoomFeedRecord) => void): () => void
  subscribeResync(fn: (reason: string) => void): () => void
}

export interface RoomEventsOptions {
  roomId: string
  /** The `rooms.events` call (`client.rooms.events`). */
  events: RoomsApi['events']
  /** The activity feed (`client.feed()`). It is not started here: the UI starts it. */
  feed: RoomEventsFeed
  /** Events per `rooms.events` call (default {@link ROOM_EVENTS_PAGE}). */
  limit?: number
  /** Called once per failed refetch with the error (the state keeps the error too). */
  onError?: (error: unknown) => void
}

export interface RoomEventsState {
  /** The transcript the client holds, in `seq` order, each event once. */
  events: RoomEvent[]
  /** The last `seq` held (0 before the first event): the next refetch asks for events after it. */
  after: number
  /** True once a refetch succeeded. */
  loaded: boolean
  /** The error of the last refetch, cleared by the next one that succeeds. */
  error: unknown
}

export interface RoomEvents {
  get(): RoomEventsState
  subscribe(listener: (state: RoomEventsState) => void): () => void
  /**
   * Fetch every event after the last `seq` held, page by page. Calls while one runs coalesce into one more pass after it,
   * so the result is never older than the newest trigger. A failure keeps the held events and the cursor.
   */
  refresh(): Promise<void>
  /**
   * Refetch on each `room.event` record of this room with a `seq` past the cursor and on every feed resync (a reconnect
   * or a missed-events gap). Starts with a `refresh()`. Returns the detach function.
   */
  attach(): () => void
}

/**
 * The transcript of one room for one person. Every refetch asks for `after: cursor`, so the events the feed missed while it
 * was down are read on reconnect, and an event is appended only when its `seq` is past the cursor: no gap and no duplicate.
 */
export function createRoomEvents(options: RoomEventsOptions): RoomEvents {
  const limit = options.limit ?? ROOM_EVENTS_PAGE
  const listeners = new Set<(state: RoomEventsState) => void>()
  let state: RoomEventsState = { events: [], after: 0, loaded: false, error: undefined }
  let running: Promise<void> | undefined
  let again = false

  const set = (next: Partial<RoomEventsState>): void => {
    state = { ...state, ...next }
    for (const listener of [...listeners]) listener(state)
  }

  /** Read pages after the cursor until a short page; append only events past the cursor. */
  async function pull(): Promise<void> {
    for (;;) {
      const page = await options.events({
        roomId: options.roomId,
        after: state.after,
        limit,
      })
      // one pass over the page in seq order: a seq repeated inside the page is kept once
      const fresh: RoomEvent[] = []
      let cursor = state.after
      for (const event of [...page.events].sort((a, b) => a.seq - b.seq)) {
        if (event.seq <= cursor) continue
        fresh.push(event)
        cursor = event.seq
      }
      if (fresh.length > 0) set({ events: [...state.events, ...fresh], after: cursor })
      // a short page is the end; a full page with nothing new would loop forever
      if (page.events.length < limit || fresh.length === 0) return
    }
  }

  async function pass(): Promise<void> {
    do {
      again = false
      try {
        await pull()
        set({ loaded: true, error: undefined })
      } catch (error) {
        set({ error })
        options.onError?.(error)
      }
    } while (again)
  }

  function refresh(): Promise<void> {
    if (running !== undefined) {
      again = true
      return running
    }
    running = pass().finally(() => {
      running = undefined
    })
    return running
  }

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    refresh,
    attach() {
      const offEvents = options.feed.subscribeEvents((record) => {
        if (record.type !== ROOM_EVENT) return
        const parsed = RoomEventRecordSchema.safeParse(record.payload)
        if (!parsed.success || parsed.data.roomId !== options.roomId) return
        // an event this client already holds: nothing to read
        if (parsed.data.seq <= state.after) return
        void refresh()
      })
      const offResync = options.feed.subscribeResync(() => {
        void refresh()
      })
      void refresh()
      return () => {
        offEvents()
        offResync()
      }
    },
  }
}

export interface RoomViewSnapshot {
  /** The room as the core last answered `rooms.get`, or undefined until the first answer. */
  view: RoomView | undefined
  /** The error of the last read, cleared by the next one that succeeds. */
  error: unknown
}

export interface RoomViewOptions {
  roomId: string
  /** The `rooms.get` call (`client.rooms.get`). */
  get: RoomsApi['get']
  /** The activity feed (`client.feed()`). It is not started here: the UI starts it. */
  feed: RoomEventsFeed
  /** Called once per failed read with the error (the snapshot keeps the error too). */
  onError?: (error: unknown) => void
}

export interface RoomViewStore {
  get(): RoomViewSnapshot
  subscribe(listener: (snapshot: RoomViewSnapshot) => void): () => void
  /**
   * Read `rooms.get` now. Calls while one runs coalesce into one more read after it. A failure keeps the last view.
   */
  refresh(): Promise<void>
  /**
   * Read again on each `room.indicator` of this room (the indicator is not in the feed, only the fact that it changed), on each
   * `room.event` of this room (members and requests change with the lines) and on every feed resync. Starts with a `refresh()`.
   * Returns the detach function. Another room's record does nothing.
   */
  attach(): () => void
}

/**
 * The room view of one person: `rooms.get` kept in step with the feed. The record `room.indicator` carries no indicator value
 * (corpus-callosum.md "Transport"), so the view is read again to learn it; the same read serves the members and the requests.
 */
export function createRoomView(options: RoomViewOptions): RoomViewStore {
  const listeners = new Set<(snapshot: RoomViewSnapshot) => void>()
  let snapshot: RoomViewSnapshot = { view: undefined, error: undefined }
  let running: Promise<void> | undefined
  let again = false

  const set = (next: Partial<RoomViewSnapshot>): void => {
    snapshot = { ...snapshot, ...next }
    for (const listener of [...listeners]) listener(snapshot)
  }

  async function pass(): Promise<void> {
    do {
      again = false
      try {
        const view = await options.get({ roomId: options.roomId })
        set({ view, error: undefined })
      } catch (error) {
        set({ error })
        options.onError?.(error)
      }
    } while (again)
  }

  function refresh(): Promise<void> {
    if (running !== undefined) {
      again = true
      return running
    }
    running = pass().finally(() => {
      running = undefined
    })
    return running
  }

  /** A record names this room in its payload (`roomId`) and parses with the schema of its type. */
  const ofThisRoom = (record: RoomFeedRecord): boolean => {
    if (record.type === ROOM_INDICATOR) {
      const parsed = RoomIndicatorRecordSchema.safeParse(record.payload)
      return parsed.success && parsed.data.roomId === options.roomId
    }
    if (record.type === ROOM_EVENT) {
      const parsed = RoomEventRecordSchema.safeParse(record.payload)
      return parsed.success && parsed.data.roomId === options.roomId
    }
    return false
  }

  return {
    get: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    refresh,
    attach() {
      const offEvents = options.feed.subscribeEvents((record) => {
        if (ofThisRoom(record)) void refresh()
      })
      const offResync = options.feed.subscribeResync(() => {
        void refresh()
      })
      void refresh()
      return () => {
        offEvents()
        offResync()
      }
    },
  }
}
