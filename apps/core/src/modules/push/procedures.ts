// The `presence.push` branch of the router (docs/specs/push.md, "Contracts"): the signed-in person acts on their own
// subscriptions and setting; there is no way to name another person's.
import { ORPCError } from '@orpc/server'
import { rpc } from '../../platform/rpc.ts'
import { PushError, type PushService } from './service.ts'

const refused = <T>(run: () => T): T => {
  try {
    return run()
  } catch (error) {
    if (error instanceof PushError) throw new ORPCError(error.code, { message: error.message })
    throw error
  }
}

export function pushProcedures(service: PushService) {
  return {
    publicKey: rpc.presence.push.publicKey.handler(() => ({ publicKey: service.publicKey() })),
    subscribe: rpc.presence.push.subscribe.handler(({ input, context }) => {
      const personId = context.principal.personId
      const record = refused(() => service.subscribe(personId, input))
      context.record('push.subscribed', { subject: personId, subscription: record.id })
      return record
    }),
    unsubscribe: rpc.presence.push.unsubscribe.handler(({ input, context }) => {
      const personId = context.principal.personId
      service.unsubscribe(personId, input)
      context.record('push.unsubscribed', { subject: personId })
      return { ok: true as const }
    }),
    list: rpc.presence.push.list.handler(({ context }) => service.list(context.principal.personId)),
    preview: {
      get: rpc.presence.push.preview.get.handler(({ context }) => ({
        preview: service.preview(context.principal.personId),
      })),
      set: rpc.presence.push.preview.set.handler(({ input, context }) => {
        const personId = context.principal.personId
        const preview = service.setPreview(personId, input.preview)
        context.record('push.preview.set', { subject: personId, preview })
        return { preview }
      }),
    },
  }
}
