import { ORPCError } from '@orpc/server'
import { rpc, rpcError } from '../../platform/rpc.ts'
import type { ProviderService } from './service.ts'

/** oRPC procedures of `providers.*` and `models.roles.*`. */
export function providerProcedures(service: ProviderService) {
  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (error) {
      return rpcError(error)
    }
  }
  return {
    providers: {
      describe: rpc.providers.describe.handler(() => service.describe()),
      list: rpc.providers.list.handler(() => service.list()),
      put: rpc.providers.put.handler(({ input, context }) =>
        guard(async () => {
          // a connection that exists is changed: its new key is `settings.provider.key`, never an add
          const existed =
            input.id !== undefined && (await service.list()).some((c) => c.id === input.id)
          const saved = await service.put(input)
          if (!existed) {
            context.record('settings.provider.add', {
              connection: saved.id,
              provider: saved.providerId,
            })
          } else if (input.settings !== undefined) {
            context.record('settings.provider.key', { connection: saved.id })
          }
          return saved
        }),
      ),
      remove: rpc.providers.remove.handler(({ input }) =>
        guard(async () => {
          await service.remove(input.id)
          return { ok: true as const }
        }),
      ),
      test: rpc.providers.test.handler(({ input }) => guard(() => service.test(input.id))),
      models: rpc.providers.models.handler(({ input }) =>
        guard(() => service.models(input.id, input.refresh)),
      ),
    },
    models: {
      roles: {
        // the guest role is the owner's business (`guests.manage`): other readers do not see it
        get: rpc.models.roles.get.handler(async ({ context }) => {
          const { guest, ...rest } = await service.roles()
          return context.capabilities.has('guests.manage') ? { ...rest, guest } : rest
        }),
        set: rpc.models.roles.set.handler(({ input, context }) => {
          if (input.role === 'guest' && !context.capabilities.has('guests.manage'))
            throw new ORPCError('FORBIDDEN', {
              message: 'only the owner may pick the guest model',
            })
          return guard(() => service.setRole(input.role, input.ref))
        }),
      },
      price: {
        list: rpc.models.price.list.handler(() => service.prices()),
        set: rpc.models.price.set.handler(({ input }) => guard(() => service.setPrice(input))),
        clear: rpc.models.price.clear.handler(({ input }) =>
          guard(async () => {
            if (!service.clearPrice(input.ref))
              throw new ORPCError('NOT_FOUND', { message: `no manual price for ${input.ref}` })
            return { ok: true as const }
          }),
        ),
      },
    },
  }
}
