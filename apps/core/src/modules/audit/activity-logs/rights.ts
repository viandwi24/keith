// The rights of the activity logs (docs/specs/activity-logs.md, "Rights"; ADR-0032 §8). One pure decision, `canReadSession`, and one
// side-effecting step on the owner path, `authorize`, that writes the audit rows the person sees under `audit.mine`. Every procedure
// of the logs calls these for each row, so a list cannot show a row its detail would refuse.
import type {
  Capability,
  LogsOwnerReadAuditDetail,
  PersonStatus,
  SessionKindName,
} from '@keith/contracts'
import { LOGS_OWNER_READ } from '@keith/contracts'
import type { AuditVia } from '@keith/db'
import { ACL_AUDIT_WINDOW_MS, type AclAudit } from '../acl-audit.ts'
import type { Audit } from '../audit.ts'

/** `READ` of the ACL bits: the owner read is a read (docs/specs/acl.md, "Owner access"). */
const READ_BITS = 4

/** What a reader may do with a session: their own, through a room they are in, through the owner path (audited), or nothing. */
export type SessionAccess = 'own' | 'room' | 'owner-path' | 'deny'

/** Why the owner reads: a list of sessions, one session (its calls), or the raw JSON of one call. */
export type LogPurpose = 'list' | 'detail' | 'raw'

/** The reader: who asks and what the role and grants allow (`capabilitiesOf`). */
export interface LogsReader {
  personId: string
  isOwner: boolean
  capabilities: ReadonlySet<Capability>
}

/** A reader that is audited on the owner path: how the request came in and the session it came in on. */
export interface AuditedLogsReader extends LogsReader {
  via: AuditVia
  /** The credential or session id of the request (the ACL window is per session); the person id when absent. */
  session?: string | null
}

/** The session as the rows of `llm_sessions` name it. `personId` is the person of a chat, task, dream or aux session. */
export interface LogsSession {
  id: string
  kind: SessionKindName
  personId?: string | undefined
  roomId?: string | undefined
}

export interface LogRightsPorts {
  /**
   * The room side (ADR-0032 §8): `canRead` is true for a current member with `r` on the room (the room ACL), false for an ex-member;
   * `activeMembers` are the members who may speak or read now, the subjects of an owner read of a room session.
   */
  rooms: {
    canRead(personId: string, roomId: string): boolean
    activeMembers(roomId: string): string[]
  }
  /** The status of a person; undefined when the person is gone. A suspended person reads nothing. */
  people: { statusOf(personId: string): PersonStatus | undefined }
  audit: Pick<Audit, 'record'>
  aclAudit: Pick<AclAudit, 'ownerAccess'>
  /** Clock of the window of the owner reads that name no person (guest sessions). Defaults to `Date.now`. */
  now?: () => number
}

export interface LogRights {
  /** The pure decision. Writes nothing. */
  canReadSession(reader: LogsReader, session: LogsSession): SessionAccess
  /**
   * The decision, and on `owner-path` the audit rows: `logs.owner-read` and `acl.owner-access` (`owner` = the session's person; for a
   * room, each active member). A list is once per window per person, a detail once per session per window, a raw read every time.
   * A guest session names no person: its row carries no subject and no `acl.owner-access` is written.
   */
  authorize(
    reader: AuditedLogsReader,
    session: LogsSession,
    options: { purpose: LogPurpose; callId?: string | undefined },
  ): SessionAccess
}

/** The rights of the activity logs over the ports. Pure except `authorize`, which writes the owner-path rows. Never throws. */
export function createLogRights(ports: LogRightsPorts): LogRights {
  const now = ports.now ?? Date.now
  /** The windows of the owner reads that name no person: key -> end of the window. */
  const seenWithoutSubject = new Map<string, number>()

  const isActive = (reader: LogsReader): boolean =>
    ports.people.statusOf(reader.personId) === 'active'

  const canReadSession = (reader: LogsReader, session: LogsSession): SessionAccess => {
    if (!isActive(reader)) return 'deny'
    const mine = reader.capabilities.has('logs.mine')
    const ownerPath = reader.isOwner && reader.capabilities.has('logs.read')

    if (session.kind === 'room') {
      if (
        mine &&
        session.roomId !== undefined &&
        ports.rooms.canRead(reader.personId, session.roomId)
      )
        return 'room'
      return ownerPath ? 'owner-path' : 'deny'
    }
    // a guest session names no person, so it is never anybody's own
    if (
      mine &&
      session.kind !== 'guest' &&
      session.personId !== undefined &&
      session.personId === reader.personId
    )
      return 'own'
    return ownerPath ? 'owner-path' : 'deny'
  }

  /** The persons an owner read of this session is about: the session's person, or each active member of a room. */
  const subjectsOf = (session: LogsSession): string[] => {
    if (session.kind === 'room')
      return session.roomId === undefined ? [] : ports.rooms.activeMembers(session.roomId)
    if (session.kind === 'guest') return []
    return session.personId === undefined ? [] : [session.personId]
  }

  const logRow = (actor: string, via: AuditVia, detail: LogsOwnerReadAuditDetail): void => {
    ports.audit.record({ kind: LOGS_OWNER_READ, actor, via, detail: { ...detail } })
  }

  const authorize: LogRights['authorize'] = (reader, session, options) => {
    const access = canReadSession(reader, session)
    if (access !== 'owner-path') return access

    const { purpose, callId } = options
    const scope: LogsOwnerReadAuditDetail['scope'] =
      purpose === 'list'
        ? 'list'
        : purpose === 'raw'
          ? 'raw'
          : callId === undefined
            ? 'session'
            : 'call'
    const caller = { by: reader.personId, via: reader.via, session: reader.session ?? null }
    const room = session.kind === 'room' ? session.roomId : undefined
    const base = {
      scope,
      sessionId: session.id,
      ...(callId === undefined ? {} : { callId }),
      ...(room === undefined ? {} : { room }),
    }
    const subjects = subjectsOf(session)

    if (subjects.length === 0) {
      // no person to show the read to: the owner's audit log keeps it, once per window: one row per list (reader + purpose,
      // whatever the sessions listed), one per detail of a session (docs/specs/activity-logs.md, "Rights")
      if (purpose !== 'raw') {
        const reader = caller.session ?? caller.by
        const key = purpose === 'list' ? `${reader}|list` : `${reader}|${purpose}|${session.id}`
        const t = now()
        const until = seenWithoutSubject.get(key)
        if (until !== undefined && until > t) return access
        seenWithoutSubject.set(key, t + ACL_AUDIT_WINDOW_MS)
      }
      logRow(caller.by, caller.via, base)
      return access
    }

    for (const subject of subjects) {
      if (purpose === 'raw') {
        // always: a raw read is never folded into a window
        ports.audit.record({
          kind: 'acl.owner-access',
          actor: caller.by,
          via: caller.via,
          detail: { kind: 'session', id: session.id, owner: subject, bits: READ_BITS },
        })
        logRow(caller.by, caller.via, { ...base, subject })
        continue
      }
      // a list is one resource per person (`list:<person>`), a detail is the session itself, a room session is the session of each
      // member (the ACL window is per resource and owner); the window is the ACL's
      const resourceId =
        purpose === 'list'
          ? `list:${subject}`
          : session.kind === 'room'
            ? `${session.id}:${subject}`
            : session.id
      const written = ports.aclAudit.ownerAccess(caller, {
        kind: 'session',
        bits: READ_BITS,
        resources: [{ id: resourceId, owner: subject }],
      })
      if (written > 0) logRow(caller.by, caller.via, { ...base, subject })
    }
    return access
  }

  return { canReadSession, authorize }
}
