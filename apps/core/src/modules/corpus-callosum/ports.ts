// The ports of the room service (docs/specs/corpus-callosum.md, "Control and limits", ADR-0026). The room defines no port of
// its own for the delivery service (P25) or the people directory: it takes the owning module's types, re-exported here, so a
// change to one of them shows in this file. The composition passes the real services; the tests pass fakes.
import type { Delivery } from '../delivery/index.ts'
import type { ParietalPorts } from '../parietal/index.ts'
import type { PeopleService } from '../people/index.ts'

export type { Audit } from '../audit/index.ts'
export type { DisclosedLine, ParietalPorts } from '../parietal/index.ts'
export type { Delivery, PeopleService }

/** What the room needs from the delivery service: one send per invitation (`deliver`, exactly once by run id). */
export type RoomDelivery = Pick<Delivery, 'deliver'>

/** What the room needs from the people directory: a person by username or id (the role, the status and the name). */
export type RoomPeople = Pick<PeopleService, 'get'>

/** What the room tools need from the presence region (P27): the disclosed line of a subject as a viewer sees it. */
export type RoomPresence = Pick<ParietalPorts, 'disclosedFor'>
