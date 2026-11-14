// The owner's test notice (`keith-core notify`, `admin.notice.send`): one delivery that needs the `notify` client capability,
// through the real delivery path (docs/specs/delivery.md, docs/specs/core-cli.md). A client that declared `notify` shows a
// toast; when none takes it, the front session gets the note (no turn). The owner reads the outcome; the audit row has no text.
import { randomUUID } from 'node:crypto'
import type { AdminNoticeSend, AdminNoticeSent, DeliveryNeeds } from '@keith/contracts'
import { ORPCError } from '@orpc/server'
import { rpc } from '../../platform/rpc.ts'
import type { Delivery } from '../delivery/index.ts'
import type { PeopleService } from '../people/index.ts'

/** The `needs` of a test notice: a note (no turn), every client that declared `notify` first, the front session last. */
export const NOTICE_NEEDS: DeliveryNeeds = {
  mode: 'note',
  capabilities: ['notify'],
  fanout: 'best',
  urgency: 'normal',
}

/** The `eh.event` name of a test notice: the TUI toast reads `Keith · notice: <text>`. */
export const NOTICE_NAME = 'notice'

export interface AdminNoticeDeps {
  delivery: Pick<Delivery, 'deliver'>
  people: Pick<PeopleService, 'get'>
  /** The run id's tail (default: a random uuid). */
  newId?: () => string
}

/** Sends the owner's test notice to one person and returns the run id and the outcome. The person is named as the CLI types it. */
export async function sendAdminNotice(
  deps: AdminNoticeDeps,
  input: AdminNoticeSend,
): Promise<AdminNoticeSent> {
  const person = await deps.people.get(input.person).catch(() => undefined)
  if (person === undefined)
    throw new ORPCError('NOT_FOUND', { message: `no person ${input.person}` })
  const id = `notice:${(deps.newId ?? randomUUID)()}`
  const outcome = await deps.delivery.deliver({
    id,
    source: 'admin',
    to: person.id,
    name: NOTICE_NAME,
    text: input.text,
    needs: NOTICE_NEEDS,
  })
  return { id, to: person.id, outcome }
}

/** The `admin.notice` procedures (owner only, see `contract.ts`). */
export function adminNoticeProcedures(deps: AdminNoticeDeps) {
  return {
    send: rpc.admin.notice.send.handler(({ input }) => sendAdminNotice(deps, input)),
  }
}
