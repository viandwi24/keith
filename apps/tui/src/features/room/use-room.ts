import { createRoomEvents, createRoomView, type KeithClient } from '@keith/client'
import { ROOM_EVENT, type RoomListItem } from '@keith/contracts'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  bannerOf,
  type InviteNotice,
  inviteNoticeOf,
  type RoomBanner,
  type RoomViewState,
  roomViewOf,
} from './room-state.ts'

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The record types that say a room changed: the transcript's `room.event` and the core's `brain.corpus-callosum.*` lines. */
const isRoomRecord = (type: string): boolean =>
  type === ROOM_EVENT || type.startsWith('brain.corpus-callosum.')

export interface Rooms {
  /** The person's rooms as `rooms.list` gives them (headers only: no transcript text; each with its invitation expiry). */
  headers: readonly RoomListItem[]
  /** The Home banner, or undefined. */
  banner: RoomBanner | undefined
  /** The invitation to accept or decline, or undefined. */
  invite: InviteNotice | undefined
  error: string | undefined
  reload(): void
}

/**
 * The person's rooms: `rooms.list` at mount, on every feed resync and on any room record (the feed sends no history).
 * `me` is the signed-in person's id (`auth.whoami`); the banner and the invitation are read from the headers. Without `me`
 * (signed out, not yet known) nothing is read and the lists are empty.
 */
export function useRooms(client: KeithClient, me: string | undefined): Rooms {
  const [headers, setHeaders] = useState<readonly RoomListItem[]>([])
  const [error, setError] = useState<string | undefined>()
  const reload = useCallback(() => {
    if (me === undefined) return
    client.rooms
      .list({})
      .then((answer) => {
        setError(undefined)
        setHeaders(answer.rooms)
      })
      .catch((e: unknown) => setError(`Failed to load rooms: ${messageOf(e)}`))
  }, [client, me])
  useEffect(() => {
    if (me === undefined) {
      setHeaders([])
      return undefined
    }
    reload()
    const feed = client.feed()
    const offEvents = feed.subscribeEvents((record) => {
      if (isRoomRecord(record.type)) reload()
    })
    const offResync = feed.subscribeResync(() => reload())
    return () => {
      offEvents()
      offResync()
    }
  }, [client, me, reload])
  const who = me ?? ''
  const banner = useMemo(() => bannerOf(headers, who), [headers, who])
  const invite = useMemo(() => inviteNoticeOf(headers, who, Date.now()), [headers, who])
  return { headers, banner, invite, error, reload }
}

export interface RoomData {
  /** The room as this person sees it, or undefined until the first read. */
  state: RoomViewState | undefined
  error: string | undefined
  reload(): void
}

/**
 * One room for the room view. The header, members, presence, indicator and confirmations come from `rooms.get` through
 * `createRoomView` (read again on the room's `room.indicator` and `room.event` records and on resync); the transcript comes from
 * `createRoomEvents`. The brain lines of the room (`brain.corpus-callosum.*`) also read the view again.
 */
export function useRoom(client: KeithClient, roomId: string, me: string): RoomData {
  const events = useMemo(
    () => createRoomEvents({ roomId, events: client.rooms.events, feed: client.feed() }),
    [client, roomId],
  )
  const view = useMemo(
    () =>
      createRoomView({
        roomId,
        get: (input) => client.rooms.get(input),
        feed: client.feed(),
      }),
    [client, roomId],
  )
  const transcript = useSyncExternalStore(
    (run) => events.subscribe(() => run()),
    () => events.get(),
  )
  const snapshot = useSyncExternalStore(
    (run) => view.subscribe(() => run()),
    () => view.get(),
  )
  useEffect(() => {
    const detachView = view.attach()
    const detachEvents = events.attach()
    const offBrain = client.feed().subscribeEvents((record) => {
      const payload = record.payload as { roomId?: unknown } | null
      if (record.type.startsWith('brain.corpus-callosum.') && payload?.roomId === roomId)
        void view.refresh()
    })
    return () => {
      detachView()
      detachEvents()
      offBrain()
    }
  }, [client, roomId, events, view])
  const state = useMemo(
    () =>
      snapshot.view === undefined
        ? undefined
        : roomViewOf({ view: snapshot.view, events: transcript.events, me, now: Date.now() }),
    [snapshot.view, transcript.events, me],
  )
  const eventsError =
    transcript.error === undefined
      ? undefined
      : `Failed to read the transcript: ${messageOf(transcript.error)}`
  const viewError =
    snapshot.error === undefined
      ? undefined
      : `Failed to load the room: ${messageOf(snapshot.error)}`
  return { state, error: viewError ?? eventsError, reload: () => void view.refresh() }
}
