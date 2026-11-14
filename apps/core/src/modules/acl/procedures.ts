import { KEITH_STEP_UP_REQUIRED } from '@keith/contracts'
import { ORPCError } from '@orpc/server'
import { type RpcContext, rpc } from '../../platform/rpc.ts'
import type { AclAuditCaller } from '../audit/index.ts'
import { stepUpDenial } from '../auth/index.ts'
import { PeopleError } from '../people/index.ts'
import type { AccessCaller, AccessService } from './access.ts'
import { AclAdminError } from './errors.ts'
import type { GroupsService } from './groups.ts'

/** Who is calling, for the audit row: the person, the listener and the credential (never its secret). */
export const callerOf = (context: RpcContext): AclAuditCaller => ({
  by: context.principal.personId,
  via: context.via,
  session: context.principal.credential?.id ?? null,
})

const mapped = <T>(run: () => Promise<T>): Promise<T> =>
  run().catch((error: unknown) => {
    if (error instanceof AclAdminError) {
      if (error.code === 'STEP_UP')
        throw new ORPCError(KEITH_STEP_UP_REQUIRED, { status: 403, message: error.message })
      throw new ORPCError(error.code, { message: error.message })
    }
    if (error instanceof PeopleError) throw new ORPCError(error.code, { message: error.message })
    throw error
  })

export { mapped as mapAclErrors }

/** oRPC `admin.groups.*` over the groups service. Authority is `groups.manage`, which only the owner role holds. */
export function groupsProcedures(service: GroupsService) {
  return {
    list: rpc.admin.groups.list.handler(() => mapped(() => service.list())),
    get: rpc.admin.groups.get.handler(({ input }) => mapped(() => service.get(input.group))),
    create: rpc.admin.groups.create.handler(({ input, context }) =>
      mapped(() => service.create(input.name, callerOf(context))),
    ),
    delete: rpc.admin.groups.delete.handler(({ input, context }) =>
      mapped(async () => {
        await service.delete(input.group, callerOf(context))
        return { ok: true as const }
      }),
    ),
    add: rpc.admin.groups.add.handler(({ input, context }) =>
      mapped(() => service.add(input.group, input.person, callerOf(context))),
    ),
    remove: rpc.admin.groups.remove.handler(({ input, context }) =>
      mapped(() => service.remove(input.group, input.person, callerOf(context))),
    ),
  }
}

/** oRPC `acl.*` over the access service. Authority is the caller's right on the resource, checked in the service. */
export function aclProcedures(service: AccessService) {
  const caller = (context: RpcContext): AccessCaller => ({
    ...callerOf(context),
    // a step-up over TCP, or the always-elevated local socket; an agent tool never passes this (it asks first)
    confirmed: stepUpDenial(context.principal, context.via) === undefined,
  })
  return {
    show: rpc.acl.show.handler(({ input, context }) =>
      mapped(() => service.show(caller(context), input)),
    ),
    share: rpc.acl.share.handler(({ input, context }) =>
      mapped(() => service.share(caller(context), input)),
    ),
    unshare: rpc.acl.unshare.handler(({ input, context }) =>
      mapped(() => service.unshare(caller(context), input)),
    ),
    chmod: rpc.acl.chmod.handler(({ input, context }) =>
      mapped(() => service.chmod(caller(context), input)),
    ),
    chgrp: rpc.acl.chgrp.handler(({ input, context }) =>
      mapped(() => service.chgrp(caller(context), input)),
    ),
    chown: rpc.acl.chown.handler(({ input, context }) =>
      mapped(() => service.chown(caller(context), input)),
    ),
  }
}
