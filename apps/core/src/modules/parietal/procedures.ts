// Presence procedures (docs/specs/parietal.md, "Contracts"). The signed-in person acts on their own clients and status:
// the service refuses another person's client id. The owner's raw read (`admin.presence.read`) is built in P27.2.4.
import type { AccessProxy } from '@keith/contracts'
import { ORPCError } from '@orpc/server'
import { rpc } from '../../platform/rpc.ts'
import type { LanNets } from '../auth/index.ts'
import type { PeopleService } from '../people/index.ts'
import { clientNetworkOf, type NetworkRules } from './network.ts'
import { ParietalError, type ParietalService } from './service.ts'

/** The settings a client's network is derived with, read at each call (the owner may change the access settings). */
export interface PresenceProcedureDeps {
  lan?: () => LanNets | undefined
  proxy?: () => AccessProxy | undefined
}

/** Turns a service refusal into the oRPC error of the same code; anything else is rethrown as it is. */
const refused = <T>(run: () => T): T => {
  try {
    return run()
  } catch (error) {
    if (error instanceof ParietalError) throw new ORPCError(error.code, { message: error.message })
    throw error
  }
}

/** The `presence` branch of the router. */
export function presenceProcedures(service: ParietalService, deps: PresenceProcedureDeps = {}) {
  const rules = (): NetworkRules => ({ lan: deps.lan?.(), proxy: deps.proxy?.() })
  return {
    clients: {
      register: rpc.presence.clients.register.handler(({ input, context }) => {
        const personId = context.principal.personId
        // the network is derived from the listener and the peer, never read from the request (docs/decisions/0033 §3)
        const network = clientNetworkOf(
          {
            via: context.via,
            ip: context.ip,
            forwarded: context.forwarded === true,
            funnel: context.funnel === true,
          },
          rules(),
        )
        const { record, created } = refused(() => service.register(personId, input, network))
        if (created) context.record('client.registered', { subject: personId, kind: input.kind })
        return record
      }),
      heartbeat: rpc.presence.clients.heartbeat.handler(({ input, context }) => {
        refused(() => service.heartbeat(context.principal.personId, input))
        return { ok: true as const }
      }),
      goodbye: rpc.presence.clients.goodbye.handler(({ input, context }) => {
        refused(() => service.goodbye(context.principal.personId, input.id))
        return { ok: true as const }
      }),
      ack: rpc.presence.clients.ack.handler(({ input, context }) => {
        refused(() => service.ack(context.principal.personId, input))
        return { ok: true as const }
      }),
      list: rpc.presence.clients.list.handler(({ context }) =>
        service.list(context.principal.personId),
      ),
      remove: rpc.presence.clients.remove.handler(({ input, context }) => {
        const personId = context.principal.personId
        refused(() => service.remove(personId, input.id))
        context.record('client.removed', { subject: personId })
        return { ok: true as const }
      }),
    },
    mine: rpc.presence.mine.handler(({ context }) => service.mine(context.principal.personId)),
    setStatus: rpc.presence.setStatus.handler(({ input, context }) => {
      const personId = context.principal.personId
      const view = service.setStatus(personId, input)
      context.record('presence.status.set', {
        subject: personId,
        busy: input.busy,
        minutes: input.minutes ?? null,
      })
      return view
    }),
    disclosure: {
      set: rpc.presence.disclosure.set.handler(({ input, context }) => {
        const personId = context.principal.personId
        const row = refused(() => service.setDisclosure(personId, input))
        context.record('presence.disclosure.set', {
          subject: personId,
          audience: row.audience,
          level: row.level,
        })
        return row
      }),
    },
  }
}

/**
 * The `admin.presence` branch: the owner's raw read of one person (P27.2.4). Owner only through `audit.read`; the call is
 * audited as `presence.read` by the rpc table (platform/rpc.ts), so the person sees it in their own audit lines.
 */
export function adminPresenceProcedures(deps: {
  service: Pick<ParietalService, 'raw'>
  people: Pick<PeopleService, 'get'>
}) {
  return {
    read: rpc.admin.presence.read.handler(async ({ input }) => {
      const person = await deps.people.get(input.person).catch(() => undefined)
      if (person === undefined)
        throw new ORPCError('NOT_FOUND', { message: `no person ${input.person}` })
      return deps.service.raw(person.id)
    }),
  }
}
