import type { SessionInfo } from '@keith/contracts'
import type { CredentialRecord, CredentialsRepo } from '@keith/db'
import { ORPCError } from '@orpc/server'
import { rpc } from '../../platform/rpc.ts'
import { stepUpDenial } from '../auth/index.ts'
import { PeopleError, type PeopleService } from '../people/index.ts'

const ok = { ok: true as const }

const info = (r: CredentialRecord, currentId: string | undefined): SessionInfo => ({
  id: r.id,
  kind: r.kind,
  label: r.label,
  methods: r.methods,
  assurance: r.assurance,
  createdAt: r.createdAt,
  lastSeenAt: r.lastSeenAt,
  lastIp: r.lastIp,
  userAgent: r.userAgent,
  idleExpiresAt: r.idleExpiresAt,
  absoluteExpiresAt: r.absoluteExpiresAt,
  current: r.id === currentId,
})

/**
 * Sessions of a person (docs/specs/auth.md): `auth.sessions.*` for the caller's own, `admin.sessions.*`
 * for any person (the owner). Hash-only storage means only metadata is ever listed.
 */
export function sessionProcedures(options: {
  credentials: CredentialsRepo
  people: PeopleService
  now?: () => number
}) {
  const { credentials, people } = options
  const now = options.now ?? Date.now
  const notFound = (): never => {
    throw new ORPCError('NOT_FOUND', { message: 'no such live session' })
  }
  return {
    auth: {
      list: rpc.auth.sessions.list.handler(({ context }) =>
        credentials
          .sessions(context.principal.personId, now())
          .map((r) => info(r, context.principal.credential?.id)),
      ),
      revoke: rpc.auth.sessions.revoke.handler(({ input, context }) => {
        const mine = credentials
          .sessions(context.principal.personId, now())
          .find((s) => s.id === input.id)
        if (mine === undefined) return notFound()
        // ending the session of this very call is a logout; any other one is a sensitive act
        if (mine.id !== context.principal.credential?.id) {
          const denied = stepUpDenial(context.principal, context.via)
          if (denied !== undefined) {
            throw new ORPCError(denied.code, { status: 403, message: denied.message })
          }
        }
        credentials.revoke(mine.id, undefined, 'self')
        context.record('credential.revoked', {
          credentialId: mine.id,
          credentialKind: mine.kind,
          subject: context.principal.personId,
          by: 'self',
        })
        return ok
      }),
    },
    admin: {
      list: rpc.admin.sessions.list.handler(async ({ input, context }) => {
        let personId = context.principal.personId
        if (input.person !== undefined) {
          try {
            personId = (await people.get(input.person)).id
          } catch (error) {
            if (error instanceof PeopleError)
              throw new ORPCError(error.code, { message: error.message })
            throw error
          }
        }
        return credentials
          .sessions(personId, now())
          .map((r) => info(r, context.principal.credential?.id))
      }),
      revoke: rpc.admin.sessions.revoke.handler(({ input, context }) => {
        const found = credentials.find(input.id)
        if (found === undefined || !credentials.revoke(input.id, undefined, 'admin'))
          return notFound()
        context.record('credential.revoked', {
          credentialId: input.id,
          credentialKind: found.kind,
          personId: found.personId,
          subject: found.personId,
          by: 'admin',
        })
        return ok
      }),
    },
  }
}
