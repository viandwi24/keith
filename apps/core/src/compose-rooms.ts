import type { FrontGenerationOf } from './platform/sessions.ts'
// The shared-room region's wiring (docs/specs/corpus-callosum.md "Region and layers", "Transport", "ACL", "Settings", "Removal
// of a person"): the lifecycle service over the room repo, the text transport and its feed, the ACL kind's transcript reads, the
// settings, the capability check of `rooms.start`, the removal part of a removed person, the suspension listener, and the
// procedures the RPC router mounts. The people service is not edited: the listener is one more `identity.changed` subscriber.

import type { ClientRecord, PersonStyle } from '@keith/contracts'
import { roomsRepo, type Sqlite, type settingsRepo } from '@keith/db'
import type {
  HarnessPlugin,
  MessageAdapter,
  SessionLock,
  StateAdapter,
  StreamLogAdapter,
} from 'eharness'
import type { ActivityStore } from 'eharness/activity'
import type { createIdentity } from './compose-identity.ts'
import { closeRoomAgent, recoverRooms } from './compose-sessions.ts'
import { emit } from './modules/brain-events/index.ts'
import { type Budget, FRONT_TURN_BUDGET_USD } from './modules/budget/index.ts'
import {
  createRoomAcl,
  createRoomAgent,
  createRoomFeed,
  createRoomHandoff,
  createRoomService,
  createRoomSettings,
  createRoomTurnSeqs,
  createRoomTurns,
  createTextTransport,
  listRoomFiles,
  type RoomAcl,
  type RoomActivity,
  type RoomDelivery,
  type RoomFeed,
  type RoomPresence,
  type RoomService,
  type RoomToolCall,
  roomProcedures,
  roomsOnIdentityChanged,
  roomsRemoval,
} from './modules/corpus-callosum/index.ts'
import {
  answerFailedLine,
  type PersonaService,
  personaBlockOf,
} from './modules/prefrontal/index.ts'
import type { ProviderService } from './modules/providers/index.ts'
import type { Logger } from './platform/logger.ts'

type Identity = ReturnType<typeof createIdentity>

export interface RoomsWiring {
  /** The current front generation of each person (ADR-0030 §2): the session of every front call. */
  generations: FrontGenerationOf
  sqlite: Sqlite
  dataDir: string
  identity: Pick<
    Identity,
    'acl' | 'aclAudit' | 'audit' | 'people' | 'capabilities' | 'removal' | 'onIdentityChanged'
  >
  settings: ReturnType<typeof settingsRepo>
  delivery: RoomDelivery
  /** The `activity-logs` plugin of the room agent (ADR-0032 §1). */
  activityLogs?: HarnessPlugin
  /** The activity feed: room lines and lifecycle records are appended here. */
  store: ActivityStore
  /** The model roles of the room agent (the `front` role, as the front agent uses it). */
  providers: ProviderService
  /** The adapters of the room agent: messages, state and streams of the core. No inbox: a room never wakes. */
  storage: { messages: MessageAdapter; state: StateAdapter; streams?: StreamLogAdapter }
  /** The budget: a turn is billed to the speaker's scope, and a speaker without budget gets no turn. */
  budget: Budget
  /** The session lock shared with the front sessions: a room turn and a front turn never run at once on one session. */
  lock: SessionLock
  /** The presence of each member as a viewer sees it (P27, the disclosure rule). */
  presence: RoomPresence
  warn: (message: string) => void
  now?: () => number
  /** Test seam: the recorder of the room tools' calls (`createRoomAgent`). */
  onToolCall?: (call: RoomToolCall) => void
  /** The persona (`prefrontal`): its `answerFailed` line is the notice of a room turn that did not answer. */
  persona?: Pick<PersonaService, 'get'>
  /** The style of one person (`prefrontal`): only the speaker's `address` enters a room reminder (P33.3.3). */
  style?: (personId: string) => PersonStyle
  /** The clients of a speaker (`parietal`, read only): the speaker's channel sets the room's answer mode (P33.4.1). */
  clients?: (personId: string) => readonly ClientRecord[]
}

/** The region as the core holds it: the service (for the core's own callers) and the RPC procedures. */
export interface RoomsRegion {
  service: RoomService
  procedures: ReturnType<typeof roomProcedures>
  /** Boot, after the front recovery: repairs the room sessions and runs the queued messages no answer followed (P30.3.5). */
  recover(log: Pick<Logger, 'info' | 'warn'>): Promise<void>
  /** Graceful stop: halts the room queues and interrupts the room turns in flight, like the front turns. */
  close(log: Pick<Logger, 'info' | 'warn'>): Promise<void>
}

export function createRooms(w: RoomsWiring): RoomsRegion {
  const { identity, store, warn } = w
  const now = w.now ?? Date.now
  const rooms = roomsRepo(w.sqlite)
  const settings = createRoomSettings(w.settings)
  const activity: RoomActivity = {
    record: (sessionId, type, payload) => emit(store, type, sessionId, null, payload, warn),
  }
  const acl: RoomAcl = createRoomAcl({
    acl: identity.acl,
    rooms,
    aclAudit: identity.aclAudit,
    audit: identity.audit,
  })
  const transport = createTextTransport({ rooms, activity: store, now, warn })
  // the private handoff of `room_handoff`: the speaker's front session through the delivery, the turn's seq as its key
  const handoff = createRoomHandoff({
    rooms,
    delivery: w.delivery,
    transport,
    audit: identity.audit,
  })
  const turnSeqs = createRoomTurnSeqs()
  // the service's feed port: one `room.event` record per recipient, no text (the transport writes the lines it fans out)
  const notice = createRoomFeed({ activity: store, warn })
  const feed: RoomFeed = {
    notify(roomId, personIds, seq) {
      for (const to of personIds) void notice.notify({ to, roomId, seq })
    },
  }
  const service = createRoomService({
    generations: w.generations,
    rooms,
    acl,
    people: identity.people,
    delivery: w.delivery,
    audit: identity.audit,
    feed,
    transport,
    activity,
    capabilities: {
      holds: async (personId, capability) => {
        const person = await identity.people.get(personId)
        return identity.capabilities.of({ personId, role: person.role }).has(capability)
      },
    },
    settings,
    dataDir: w.dataDir,
    now,
    warn,
  })
  // suspension ends the person's memberships at once; the people service is not edited (a listener on identity.changed)
  identity.onIdentityChanged(roomsOnIdentityChanged(service))
  // a removed person's memberships are kept, exported or purged with the rest of their data (ADR-0027 §26)
  identity.removal.registry.registerRemoval({
    module: 'corpus-callosum',
    onPersonRemoved: roomsRemoval({ service, acl, sqlite: w.sqlite, dataDir: w.dataDir }),
  })
  // the room agent (`agent.ts`) and its turns (`turns.ts`): the speaker is the principal, the budget is the speaker's
  const name = async (personId: string): Promise<string> =>
    (await identity.people.get(personId).catch(() => undefined))?.name ?? personId
  const agent = createRoomAgent({
    providers: w.providers,
    ...(w.activityLogs === undefined ? {} : { activityLogs: w.activityLogs }),
    storage: w.storage,
    dataDir: w.dataDir,
    ...(w.onToolCall === undefined ? {} : { onToolCall: w.onToolCall }),
    tools: {
      rooms,
      service,
      presence: w.presence,
      transport,
      people: identity.people,
      handoff,
      turnSeqs,
      now,
    },
    context: {
      rooms,
      disclosedFor: (viewer, subject) => w.presence.disclosedFor(viewer, subject),
      listWorkspace: (roomId) => listRoomFiles(w.dataDir, roomId),
      now,
      name,
      // the persona block: the same text for every speaker (ADR-0026, ADR-0029 §4); read at each reminder
      persona: () => personaBlockOf(w.persona),
      addressOf: (speaker) => {
        try {
          return w.style?.(speaker).address ?? undefined
        } catch {
          return undefined
        }
      },
      // the speaker's clients only: the speaker's channel gives the room's mode line (P33.4.1)
      clientsOf: (speaker) => w.clients?.(speaker) ?? [],
    },
    budget: w.budget.config({ maxTurnUsd: FRONT_TURN_BUDGET_USD }),
  })
  const turns = createRoomTurns({
    agent,
    lock: w.lock,
    service,
    rooms,
    transport,
    budget: w.budget,
    settings,
    activity,
    turnSeqs,
    now,
    warn,
    answerFailedLine: () => answerFailedLine(w.persona),
  })
  const procedures = roomProcedures({
    service,
    turns,
    rooms,
    acl,
    people: identity.people,
    presence: w.presence,
    indicators: transport,
    settings,
    dataDir: w.dataDir,
    now,
  })
  const care = { rooms, agent, turns, lock: w.lock }
  return {
    service,
    procedures,
    recover: (log) => recoverRooms(care, log),
    close: (log) => closeRoomAgent(care, log),
  }
}
