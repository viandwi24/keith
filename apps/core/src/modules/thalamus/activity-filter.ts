import { NODE_CHANGED, ROOM_EVENT, ROOM_INDICATOR } from '@keith/contracts'
import type { ActivityRecord } from 'eharness/activity'
import { personOfSession } from '../../platform/sessions.ts'
import type { Principal } from '../auth/index.ts'
import { MOTOR_REMOTE_TOOL } from '../motor/index.ts'

/** The brain event of a room turn (corpus-callosum.md "Events"). It is never a feed record for the owner or a member. */
const ROOM_TURN_BRAIN = 'brain.corpus-callosum.turn'
/** The session id prefix of a room's session (corpus-callosum.md "The room session and the principal"). */
const ROOM_SESSION_PREFIX = 'room:'

/**
 * Which activity records a principal receives (docs/specs/thalamus.md, "Activity feed"):
 *
 * - everyone: the events of their own sessions (front and the workers of their tasks), and `node-changed`
 *   (every person holds `nodes.read`: nodes are Keith's self layer, ADR-0020 and ADR-0027 §9);
 * - the owner also: system events (no session: nodes, budget) and `brain.amygdala.wait` of another
 *   person's session when the item is one the owner answers (`motor_remote`). That event carries
 *   the tool name and a count, never a message preview.
 *
 * - plugin events (`plugin.<id>.<event>`, one record per recipient): only the person named in `to`, and
 *   everyone for `*`. The owner gets nothing of another person's events (the guest rule waits for P17).
 *
 * - `identity.changed` is written on the affected person's own front session, so the first rule shows it to
 *   that person only (and the owner never gets another person's).
 *
 * - shared rooms (docs/specs/corpus-callosum.md "Transport"; these rules run before the session rule, since a room
 *   session is no person's and would read as a system record):
 *   - `room.event` (one record per active member, `to` the person): only the person named in `to`;
 *   - `room.indicator` (one record per active member, `to` the person, no indicator value): only the person named in `to`, so the
 *     owner, who may not be a member, gets none (it is checked before the owner's lifecycle rule);
 *   - the owner, who may not be a member, gets the room lifecycle records (`room.*` other than `room.turn.*`);
 *   - `room.turn.*` and `brain.corpus-callosum.turn` never reach the feed through this path: a turn's text is
 *     for the room's members, and they read it through `room.event` and `rooms.events`;
 *   - a record of a room session (`room:` id) reaches no one through this path.
 *
 * Nothing else of another person's session reaches the owner. The person comes from the record's
 * session id alone; a record whose session is not a front or worker session is a system record.
 */
export function activityFilter(principal: Principal): (record: ActivityRecord) => boolean {
  const owner = principal.role === 'owner'
  return (record) => {
    if (record.type === NODE_CHANGED) return true
    if (record.type.startsWith('plugin.')) {
      const to = (record.payload as { to?: unknown } | null)?.to
      return to === principal.personId || to === '*'
    }
    if (record.type === ROOM_EVENT || record.type === ROOM_INDICATOR) {
      const to = (record.payload as { to?: unknown } | null)?.to
      return to === principal.personId
    }
    if (record.type.startsWith('room.')) {
      if (record.type.startsWith('room.turn.')) return false
      return owner
    }
    if (record.type === ROOM_TURN_BRAIN) return false
    if (record.sessionId?.startsWith(ROOM_SESSION_PREFIX)) return false
    if (record.sessionId === null || record.sessionId === undefined) return owner
    const person = personOfSession(record.sessionId)
    if (person === principal.personId) return true
    if (!owner) return false
    if (person === undefined) return true
    const toolName = (record.payload as { toolName?: unknown } | null)?.toolName
    return record.type === 'brain.amygdala.wait' && toolName === MOTOR_REMOTE_TOOL
  }
}
