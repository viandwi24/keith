import type { AclStore, KindDef } from '@keith/acl'
import type { AclActor } from '@keith/contracts'
import type { EventRecord, RoomsRepo } from '@keith/db'
import type { AclAudit, AclAuditCaller, Audit } from '../audit/index.ts'

// The ACL resource of a room (docs/specs/corpus-callosum.md, "ACL", ADR-0020 §1 and §2, ADR-0026 §4). One resource row per room:
// the initiator is its owner, each member who accepts gets one entry `user:<person>`: `r` always, `r` and `w` while the member
// may speak. Leaving, removal and the end of the room take `w` away; `r` stays, and the transcript read is cut at `left_at` by
// the room repo. A room grant never covers another kind: a note of a member is still denied to everyone else.

/** The resource kind of a room's transcript and workspace. Core registers it at boot (`compose-identity.ts`). */
export const ROOM_KIND = 'room'
/** A container: a place with a transcript and a workspace (`0o700` by default, the owner holds what the class means). */
export const ROOM_KIND_DEF: KindDef = { class: 'container' }

const READ = 4
const WRITE = 2

/** Who reads the transcript: the actor (for the evaluator) and the caller (for the audit rows). */
export interface TranscriptReader {
  actor: AclActor
  caller: AclAuditCaller
}

export interface RoomAclOptions {
  acl: AclStore
  rooms: RoomsRepo
  aclAudit: Pick<AclAudit, 'ownerAccess'>
  audit: Pick<Audit, 'record'>
}

export interface RoomAcl {
  /** A room starts: the resource row, owner = initiator, the kind's default mode. */
  create(roomId: string, initiator: string): void
  /** An acceptance: an entry `user:<person>` with `r` and `w`. Replaces a previous entry (a member who rejoins). */
  grant(roomId: string, personId: string, by: string): void
  /**
   * A leave, a removal or the end of the room: the entry keeps `r` and loses `w`. A person with no entry (never accepted, declined)
   * gets none, so this never grants anything.
   */
  revokeWrite(roomId: string, personId: string, by: string): void
  /** The `w` marker: the person may speak. The room service checks membership on every write as well. */
  canWrite(actor: AclActor, roomId: string): boolean
  /** Whether the transcript may be read at all. Members who left still pass (their events are cut by the repo). */
  canRead(actor: AclActor, roomId: string): boolean
  /**
   * The transcript the reader may see: events after `after`, at most `limit`, oldest first. `undefined` when the reader has no
   * `r` (the caller answers `NOT_FOUND`). A member sees what the repo allows (up to `left_at`). The instance owner who has no
   * right of their own reads the whole transcript through root access: that read writes `acl.owner-access` and `room.read`.
   */
  read(
    reader: TranscriptReader,
    roomId: string,
    after: number,
    limit: number,
  ): EventRecord[] | undefined
}

/** The ACL side of the shared rooms. Writes are plain `setEntry`/`createResource` calls; the room service decides when. */
export function createRoomAcl(options: RoomAclOptions): RoomAcl {
  const { acl, rooms, aclAudit, audit } = options
  const subjectOf = (personId: string) => `user:${personId}`

  const requireResource = (roomId: string) => {
    const res = acl.getResource(ROOM_KIND, roomId)
    if (res === undefined) throw new Error(`no ACL resource for room ${roomId}`)
    return res
  }

  return {
    create(roomId, initiator) {
      acl.createResource({ kind: ROOM_KIND, id: roomId, ownerId: initiator })
    },

    grant(roomId, personId, by) {
      requireResource(roomId)
      acl.setEntry(
        ROOM_KIND,
        roomId,
        { subject: subjectOf(personId), bits: READ | WRITE, effect: 'allow' },
        by,
      )
    },

    revokeWrite(roomId, personId, by) {
      const res = requireResource(roomId)
      const entry = res.entries.find(
        (e) => e.subject === subjectOf(personId) && e.effect === 'allow',
      )
      if (entry === undefined || (entry.bits & WRITE) === 0) return
      acl.setEntry(
        ROOM_KIND,
        roomId,
        { subject: subjectOf(personId), bits: READ, effect: 'allow' },
        by,
      )
    },

    canWrite(actor, roomId) {
      return acl.check(actor, ROOM_KIND, roomId, WRITE).allowed
    },

    canRead(actor, roomId) {
      return acl.check(actor, ROOM_KIND, roomId, READ).allowed
    },

    read({ actor, caller }, roomId, after, limit) {
      const decision = acl.check(actor, ROOM_KIND, roomId, READ)
      if (!decision.allowed) return undefined
      if (!decision.ownerAccess) return rooms.eventsForMember(roomId, actor.id, after, limit)
      // root access only: the instance owner is not a member of this room
      const res = requireResource(roomId)
      aclAudit.ownerAccess(caller, {
        kind: ROOM_KIND,
        bits: READ,
        resources: [{ id: roomId, owner: res.ownerId }],
      })
      // the initiator and the members active now see the row in audit.mine: person ids only, never the text
      const members = rooms
        .members(roomId)
        .filter((m) => m.status === 'active')
        .map((m) => m.personId)
      audit.record({
        kind: 'room.read',
        actor: caller.by,
        via: caller.via,
        detail: { roomId, owner: res.ownerId, members },
      })
      return rooms.eventsForOwner(roomId, after, limit)
    },
  }
}
