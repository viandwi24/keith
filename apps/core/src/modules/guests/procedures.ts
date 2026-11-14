import { ORPCError } from '@orpc/server'
import { rpc } from '../../platform/rpc.ts'
import type { GuestAdmin } from './admin.ts'
import { GuestError } from './settings.ts'

const mapped = <T>(run: () => Promise<T>): Promise<T> =>
  run().catch((error: unknown) => {
    if (error instanceof GuestError) throw new ORPCError(error.code, { message: error.message })
    throw error
  })

/**
 * oRPC `admin.guests.*` over the guest admin. Authority is `guests.manage` (owner only); every call that changes
 * something is `sensitive` (a step-up over TCP, checked by the rpc layer) and audited here.
 */
export function guestProcedures(admin: GuestAdmin) {
  return {
    guests: {
      get: rpc.admin.guests.get.handler(() => mapped(() => admin.status())),
      set: rpc.admin.guests.set.handler(({ input, context }) =>
        mapped(async () => {
          const { status, change } = await admin.set(input)
          context.record('guest.settings', { ...change })
          return status
        }),
      ),
      killswitch: rpc.admin.guests.killswitch.handler(({ input, context }) =>
        mapped(async () => {
          const done = await admin.killswitch(input.on)
          context.record('guest.killswitch', { on: input.on, ended: done.ended })
          return done
        }),
      ),
      list: rpc.admin.guests.list.handler(() => admin.list()),
      peek: rpc.admin.guests.peek.handler(({ input, context }) =>
        mapped(async () => {
          const peek = await admin.peek(input.id)
          // the audit row says that and when an owner looked, never what the visitor said
          context.record('guest.peek', { guestId: peek.id, messages: peek.messages.length })
          return peek
        }),
      ),
      end: rpc.admin.guests.end.handler(({ input, context }) =>
        mapped(async () => {
          const done = await admin.end(input.id)
          context.record('guest.session.ended-by-owner', { guestId: input.id })
          return done
        }),
      ),
    },
  }
}
