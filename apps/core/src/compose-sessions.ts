import type { EventRecord, RoomsRepo, TasksRepo } from '@keith/db'
import type { DeadInboxItem, HarnessAgent, SessionLock } from 'eharness'
import type { ActivityStore } from 'eharness/activity'
import { type RoomTurns, roomSessionId } from './modules/corpus-callosum/index.ts'
import type { Cortex } from './modules/cortex/index.ts'
import type { PeopleService } from './modules/people/index.ts'
import { recoverSession } from './modules/resume/index.ts'
import { applyReconcile } from './modules/tasks/index.ts'
import type { Logger } from './platform/logger.ts'
import {
  countsFor,
  type FrontGenerationOf,
  frontSessionId,
  frontSessionOptions,
  isGuestSession,
  peopleFor,
  personOfSession,
  type SessionPurpose,
} from './platform/sessions.ts'

const DEAD_LETTER_NOTICE = 'A message failed repeatedly and was stopped; see the log.'
/** Rooms are few; every room is read at boot (a limit above any real count, not a page size). */
const ROOMS_AT_BOOT = 1_000_000
/** Events read per page when the transcript of a room is scanned for unanswered messages. */
const EVENT_PAGE = 500

/** The rooms the boot and the stop care for: every room that has not ended (its turns run like a front turn's). */
const liveRooms = (rooms: Pick<RoomsRepo, 'list'>) =>
  rooms.list(ROOMS_AT_BOOT).filter((room) => room.state !== 'ended')

/**
 * The queued messages of a room that no Keith answer followed, in seq order: a `say` row with `data.queued`, no `data.refused`,
 * and no `keith` row whose `data.answers` is its seq (corpus-callosum.md, "Recovery").
 */
export function unansweredQueued(
  rooms: Pick<RoomsRepo, 'eventsForOwner'>,
  roomId: string,
): EventRecord[] {
  const events: EventRecord[] = []
  for (let after = 0; ; ) {
    const page = rooms.eventsForOwner(roomId, after, EVENT_PAGE)
    events.push(...page)
    if (page.length < EVENT_PAGE) break
    after = page[page.length - 1]?.seq ?? after
  }
  const answered = new Set<number>()
  for (const event of events) {
    const answers = event.data?.answers
    if (event.kind === 'keith' && typeof answers === 'number') answered.add(answers)
  }
  return events.filter(
    (event) =>
      event.kind === 'say' &&
      event.data?.queued === true &&
      event.data?.refused !== true &&
      !answered.has(event.seq),
  )
}

export interface RoomCareDeps {
  rooms: Pick<RoomsRepo, 'list' | 'eventsForOwner'>
  /** The room agent (`createRoomAgent`): its sessions are the rooms' sessions. */
  agent: HarnessAgent
  turns: Pick<RoomTurns, 'redrive' | 'halt'>
  lock: SessionLock
}

/**
 * Boot: repairs the current-generation session of every live room (`recoverSession`, no principal: a room turn has no
 * rights outside its speaker), then runs each unanswered queued message once, in seq order, as its own turn. A second boot
 * finds it answered and runs nothing. Never throws: a failed repair is logged and boot goes on.
 */
export async function recoverRooms(
  deps: RoomCareDeps,
  log: Pick<Logger, 'info' | 'warn'>,
): Promise<void> {
  const rooms = liveRooms(deps.rooms)
  for (const room of rooms) {
    await recoverSession(deps.agent, roomSessionId(room.id, room.generation), deps.lock, log)
  }
  for (const room of rooms) {
    for (const row of unansweredQueued(deps.rooms, room.id)) {
      if (row.speaker === null || row.text === null) continue
      deps.turns.redrive({ roomId: room.id, speakerId: row.speaker, seq: row.seq, text: row.text })
    }
  }
}

/**
 * Graceful stop: the room turns are halted (no queued message starts) and the room agent is closed with `inFlight:
 * 'interrupt'`, so a turn in flight ends `stop: 'interrupted'` like a front turn (`closeAgent`). Its message stays queued.
 */
export async function closeRoomAgent(
  deps: RoomCareDeps,
  log: Pick<Logger, 'info' | 'warn'>,
): Promise<void> {
  deps.turns.halt()
  let running = 0
  for (const room of liveRooms(deps.rooms)) {
    const stats = await deps.agent
      .peek(roomSessionId(room.id, room.generation))
      .stats()
      .catch(() => undefined)
    if (stats?.activeTurn != null) running += 1
  }
  if (running > 0) log.info(`interrupting ${running} room turn(s) in flight`)
  await deps.agent.close({ inFlight: 'interrupt' })
}

export interface SessionCareDeps {
  people: Pick<PeopleService, 'list' | 'get' | 'owner'>
  lock: SessionLock
  logger: Logger
  /** The front agent (built after this, read lazily). */
  lead: () => HarnessAgent | undefined
  /** The current front generation of each person (ADR-0030 §2): the session each front call goes to. */
  generations: FrontGenerationOf
}

/**
 * Everything the core does to every person's front session (docs/specs/people.md, "Isolation"):
 * the sessions of the people who exist (boot recovery, graceful stop) and of the active ones
 * (reconcile), and where a dead letter goes. Nothing is routed to a person who is not active.
 */
export function createSessionCare(deps: SessionCareDeps) {
  const { people, lock, logger, generations } = deps
  const fronts = async (purpose: SessionPurpose): Promise<string[]> =>
    peopleFor(purpose, await people.list()).map((p) =>
      frontSessionId(p.id, generations.current(p.id)),
    )

  return {
    /**
     * An inbox item given up on: log it, then tell the person it belongs to. A worker's item goes to
     * the front of its parent chain (the id says whose); an item without a session goes to the
     * current owner. A person who is suspended or gone is only logged.
     */
    async onDeadLetter(item: DeadInboxItem): Promise<void> {
      logger.error('inbox item dead-lettered', {
        sessionId: item.sessionId,
        kind: item.kind,
        attempts: item.attempts,
        reason: item.reason,
        ...(item.lastError === undefined ? {} : { lastError: item.lastError }),
      })
      // a guest's session is only logged: its text never reaches the owner or any person (ADR-0027 §20, F-049)
      if (isGuestSession(item.sessionId)) return
      try {
        const person = personOfSession(item.sessionId) ?? (await people.owner())?.id
        if (person === undefined) return
        const target = await people.get(person).catch(() => undefined)
        if (target === undefined || !countsFor('route', target.status)) return
        const id = frontSessionId(person, generations.current(person))
        await deps
          .lead()
          ?.session(id, frontSessionOptions(id, lock))
          .inject('eh.notice', { level: 'error', message: DEAD_LETTER_NOTICE })
      } catch (error) {
        logger.warn(`dead letter notice failed: ${error instanceof Error ? error.message : error}`)
      }
    },

    /** Boot: repair the turn a dead process left in each person's front session. */
    async recoverAll(agent: HarnessAgent): Promise<void> {
      for (const id of await fronts('recover')) await recoverSession(agent, id, lock, logger)
    },

    /** Repair and report workers that died with a previous process, per active person (idempotent). */
    async reconcileAll(
      agent: HarnessAgent,
      cortex: Cortex,
      board: { tasks: TasksRepo; store: ActivityStore },
    ): Promise<void> {
      let ids: string[]
      try {
        ids = await fronts('route')
      } catch (error) {
        logger.warn(`reconcile failed: ${error instanceof Error ? error.message : error}`)
        return
      }
      // one person's failure is logged with that person and the others are still repaired (ADR-0027 §15)
      for (const id of ids) {
        try {
          applyReconcile(
            board.tasks,
            board.store,
            await cortex.reconcile(agent.session(id, frontSessionOptions(id, lock))),
          )
        } catch (error) {
          logger.warn(
            `reconcile failed for ${id}: ${error instanceof Error ? error.message : error}`,
          )
        }
      }
    },

    /**
     * Graceful stop: close the agent and interrupt each turn in flight exactly as boot recovery
     * would (`stop: 'interrupted'` plus the `EH_TURN_INTERRUPTED` notice), so the next boot shows
     * a turn the owner can `/continue`. The turns in flight are counted first, for the log.
     */
    async closeAgent(agent: HarnessAgent): Promise<void> {
      let running = 0
      for (const id of await fronts('recover').catch(() => [])) {
        const stats = await agent
          .peek(id)
          .stats()
          .catch(() => undefined)
        if (stats?.activeTurn != null) running += 1
      }
      if (running > 0) logger.info(`interrupting ${running} turn(s) in flight`)
      await agent.close({ inFlight: 'interrupt' })
    },
  }
}
