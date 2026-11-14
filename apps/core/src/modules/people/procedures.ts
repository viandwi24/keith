import { ORPCError } from '@orpc/server'
import { type RpcContext, rpc } from '../../platform/rpc.ts'
import { HasherBusyError } from '../auth/index.ts'
import type { AliasesService } from './aliases.ts'
import type { PersonExporter } from './export.ts'
import type { GrantsService } from './grants.ts'
import { PeopleError, type PeopleService } from './people.ts'
import type { SecretsService } from './secrets.ts'

const mapped = <T>(run: () => Promise<T>): Promise<T> =>
  run().catch((error: unknown) => {
    if (error instanceof PeopleError) throw new ORPCError(error.code, { message: error.message })
    if (error instanceof HasherBusyError)
      throw new ORPCError('SERVICE_UNAVAILABLE', { message: 'busy: try again in a moment' })
    throw error
  })

/** oRPC `admin.people.*` over the people service. Authority is the capability metadata. */
export function peopleProcedures(
  service: PeopleService,
  secrets: SecretsService,
  grants: GrantsService,
  aliases: AliasesService,
  exporter: PersonExporter,
) {
  const by = (context: RpcContext) => ({ actor: context.principal.personId, via: context.via })
  return {
    list: rpc.admin.people.list.handler(() => mapped(() => service.list())),
    get: rpc.admin.people.get.handler(({ input }) => mapped(() => service.get(input.person))),
    add: rpc.admin.people.add.handler(({ input, context }) => {
      return mapped(() => service.add(input, by(context)))
    }),
    rename: rpc.admin.people.rename.handler(({ input, context }) => {
      return mapped(() => service.rename(input.person, input, by(context)))
    }),
    setRole: rpc.admin.people.setRole.handler(({ input, context }) => {
      return mapped(() => service.setRole(input.person, input.role, by(context)))
    }),
    suspend: rpc.admin.people.suspend.handler(({ input, context }) => {
      return mapped(() => service.suspend(input.person, by(context)))
    }),
    reactivate: rpc.admin.people.reactivate.handler(({ input, context }) => {
      return mapped(() => service.reactivate(input.person, by(context)))
    }),
    setLogin: rpc.admin.people.setLogin.handler(({ input, context }) =>
      mapped(() => service.setLogin(input.person, input.canLogin, by(context))),
    ),
    export: rpc.admin.people.export.handler(({ input, context }) =>
      mapped(() => exporter.exportPerson(input, by(context))),
    ),
    remove: rpc.admin.people.remove.handler(({ input, context }) => {
      return mapped(async () => ({
        ok: true as const,
        ...(await service.remove(input.person, by(context))),
      }))
    }),
    transferOwner: rpc.admin.people.transferOwner.handler(({ input, context }) => {
      return mapped(() => service.transferOwner(input.person, by(context)))
    }),
    setPassword: rpc.admin.people.setPassword.handler(({ input, context }) => {
      return mapped(async () => {
        await secrets.setPassword(input.person, input.password, by(context))
        return { ok: true as const }
      })
    }),
    setPin: rpc.admin.people.setPin.handler(({ input, context }) => {
      return mapped(async () => {
        await secrets.setPin(input.person, input.pin, by(context))
        return { ok: true as const }
      })
    }),
    clearSecret: rpc.admin.people.clearSecret.handler(({ input, context }) => {
      return mapped(async () => {
        await secrets.clear(input.person, input.kind, by(context))
        return { ok: true as const }
      })
    }),
    grants: rpc.admin.people.grants.handler(({ input }) => mapped(() => grants.list(input.person))),
    grant: rpc.admin.people.grant.handler(({ input, context }) =>
      mapped(() => grants.grant(input.person, input.capability, by(context))),
    ),
    revokeGrant: rpc.admin.people.revokeGrant.handler(({ input, context }) =>
      mapped(() => grants.revoke(input.person, input.capability, by(context))),
    ),
    alias: {
      list: rpc.admin.people.alias.list.handler(({ input }) =>
        mapped(() => aliases.list(input.person)),
      ),
      add: rpc.admin.people.alias.add.handler(({ input, context }) =>
        mapped(() => aliases.add(input.person, input.kind, input.value, by(context))),
      ),
      remove: rpc.admin.people.alias.remove.handler(({ input, context }) =>
        mapped(async () => {
          await aliases.remove(input.value, by(context))
          return { ok: true as const }
        }),
      ),
    },
    unlock: rpc.admin.people.unlock.handler(({ input, context }) => {
      return mapped(async () => ({
        ok: true as const,
        wasLocked: await secrets.unlock(input.person, by(context)),
      }))
    }),
  }
}

/** `auth.pin.set`: a person sets their own PIN (the call needs a step-up over TCP, `permissions.md`). */
export function selfPinProcedures(secrets: SecretsService) {
  return {
    set: rpc.auth.pin.set.handler(({ input, context }) =>
      mapped(async () => {
        await secrets.setPin(context.principal.personId, input.pin, {
          actor: context.principal.personId,
          via: context.via,
        })
        return { ok: true as const }
      }),
    ),
  }
}
