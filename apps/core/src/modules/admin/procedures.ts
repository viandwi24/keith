import {
  type Access,
  APPROVAL_PING_DEFAULT_HOURS,
  APPROVAL_TTL_DEFAULT_HOURS,
  APPROVAL_TTL_MAX_HOURS,
  AUDIT_PRIVACY_NOTICE,
  AUDIT_PRIVACY_NOTICE_TEXT,
  type CapabilityRegistry,
  type TokenInfo,
} from '@keith/contracts'
import type {
  AuditRepo,
  CredentialsRepo,
  DeviceRequestsRepo,
  SettingsRepo,
  TokensRepo,
} from '@keith/db'
import type { ViewHost } from '@keith/host/views'
import { ORPCError } from '@orpc/server'
import type { Config } from '../../platform/config.ts'
import { rpc } from '../../platform/rpc.ts'
import {
  type AccessService,
  aclProcedures,
  type GroupsService,
  groupsProcedures,
} from '../acl/index.ts'
import { createApprovalSettings } from '../amygdala/index.ts'
import {
  type AuditRetention,
  DEFAULT_AUDIT_RETENTION_DAYS,
  listMine,
  MAX_AUDIT_RETENTION_DAYS,
} from '../audit/index.ts'
import {
  createCredential,
  DeviceError,
  type DeviceLogin,
  type LocalAccess,
  type PolicyStore,
} from '../auth/index.ts'
import type { Delivery } from '../delivery/index.ts'
import { type GuestAdmin, guestProcedures } from '../guests/index.ts'
import type { SuccessionProcedures } from '../hypothalamus/index.ts'
import { adminPresenceProcedures, type ParietalService } from '../parietal/index.ts'
import {
  type AliasesService,
  type GrantsService,
  PeopleError,
  type PeopleService,
  type PersonExporter,
  peopleProcedures,
  type SecretsService,
  selfPinProcedures,
} from '../people/index.ts'
import {
  type PluginAdmin,
  pluginProcedures,
  type ReviewService,
  reviewProcedures,
} from '../plugins/index.ts'
import { authLocalProcedures } from './auth-local.ts'
import { authPolicyProcedures } from './auth-policy.ts'
import { deriveBindHost, effectiveNetwork, SETTING } from './network.ts'
import { adminNoticeProcedures } from './notice.ts'
import { sessionProcedures } from './sessions.ts'

export interface AdminProceduresOptions {
  config: Config
  settings: SettingsRepo
  tokens: TokensRepo
  credentials: CredentialsRepo
  devices: DeviceRequestsRepo
  deviceLogin: DeviceLogin
  audit: AuditRepo
  people: PeopleService
  /** The parietal service: the owner's raw presence read (`admin.presence.read`). */
  parietal: Pick<ParietalService, 'raw'>
  /** The delivery service: the owner's test notice (`admin.notice.send`). */
  delivery: Pick<Delivery, 'deliver'>
  peopleSecrets: SecretsService
  grants: GrantsService
  groups: GroupsService
  /** The `admin.succession` procedures (succession.md): the stubs until P29.1.5 and P29.3.2 land. */
  succession: SuccessionProcedures
  /** The owner review queue (`admin.reviews.*`). */
  reviews: ReviewService
  /** Guest mode for the owner (`admin.guests.*`, `guests.md`). */
  guests: GuestAdmin
  /** The plugin layer for the operator (`admin.plugins.*`) and the capability registry (`admin.capabilities.list`). */
  plugins: PluginAdmin
  /** The open plugin terminal views (`admin.plugins.views`). */
  views?: Pick<ViewHost, 'snapshot'>
  capabilityRegistry: CapabilityRegistry
  access: AccessService
  /** The audit log's retention setting (`admin.audit.retention.*`). */
  auditRetention: AuditRetention
  /** The local socket's idle-lock and trust (`admin.auth.local.*`). */
  local: LocalAccess
  /** The kinds of secret (`pin`, `password`) a person has. */
  secretKinds: (personId: string) => readonly string[]
  /** The stored sign-in policy (`admin.auth.policy.*`). */
  policies: PolicyStore
  aliases: AliasesService
  /** `admin.people.export`: an archive of a person's data (owner only, ADR-0027 §26). */
  exporter: PersonExporter
  /** The address the server is bound to right now (set by the process that runs the listener). */
  bound: () => { host?: string; port?: number }
}

const ok = { ok: true as const }

/** The settings key that says a person saw the audit notice (docs/specs/auth.md, "Audit"). */
const noticeKey = (personId: string): string => `notice.${AUDIT_PRIVACY_NOTICE}.${personId}`

/** The owner revokes any credential; anyone else only their own (permissions.md: `tokens.manage`, `devices.manage`). */
const mayRevoke = (principal: { personId: string; role: string }, owner: string | undefined) =>
  principal.role === 'owner' || owner === principal.personId

/** oRPC `admin.*`, `auth.whoami` and `auth.logout` (the Keith contract; used by `keith-core`). */
export function adminProcedures(options: AdminProceduresOptions) {
  const { config, settings, tokens, credentials, devices, deviceLogin } = options
  const access = (): Access => {
    const net = effectiveNetwork(config, settings)
    const bound = options.bound()
    return {
      mode: net.mode,
      host: net.host,
      port: bound.port ?? net.port,
      proxy: net.proxy,
      publicUrl: net.publicUrl ?? null,
      restartRequired: bound.host !== undefined && bound.host !== net.host,
    }
  }
  const ownerOnly = (role: string): void => {
    if (role !== 'owner')
      throw new ORPCError('FORBIDDEN', {
        message: 'only the owner may read or change the audit retention',
      })
  }
  const retention = () => ({
    days: options.auditRetention.days(),
    defaultDays: DEFAULT_AUDIT_RETENTION_DAYS,
    maxDays: MAX_AUDIT_RETENTION_DAYS,
  })
  const approvals = createApprovalSettings(settings)
  const approvalsView = () => ({
    ttlHours: approvals.ttlHours(),
    defaultHours: APPROVAL_TTL_DEFAULT_HOURS,
    maxHours: APPROVAL_TTL_MAX_HOURS,
    pingBeforeHours: approvals.pingBeforeHours(),
    defaultPingBeforeHours: APPROVAL_PING_DEFAULT_HOURS,
  })
  const sessions = sessionProcedures({ credentials, people: options.people })
  const notFound = (error: unknown): never => {
    if (error instanceof DeviceError) throw new ORPCError('NOT_FOUND', { message: error.message })
    throw error
  }
  return {
    auth: {
      whoami: rpc.auth.whoami.handler(({ context }) => {
        const { principal, via } = context
        return {
          personId: principal.personId,
          name: principal.name ?? principal.personId,
          username: principal.username ?? null,
          role: principal.role,
          via,
          credentialKind: principal.credential?.kind ?? null,
          ...(principal.credential?.methods === undefined
            ? {}
            : { methods: [...principal.credential.methods] }),
          ...(principal.credential?.assurance === undefined
            ? {}
            : { assurance: principal.credential.assurance }),
          elevated: principal.elevated === true,
          elevatedUntil:
            principal.elevated === true ? (principal.credential?.elevatedUntil ?? null) : null,
          // core ids and the ids of loaded plugins the person holds (docs/specs/plugins.md)
          capabilities: [...context.capabilities].sort(),
        }
      }),
      sessions: sessions.auth,
      pin: selfPinProcedures(options.peopleSecrets),
      logout: rpc.auth.logout.handler(({ context }) => {
        const own = context.principal.credential
        if (own !== undefined) {
          const revoked =
            own.kind === 'legacy'
              ? tokens.revoke(own.id)
              : credentials.revoke(own.id, undefined, 'logout')
          if (revoked) {
            context.record('credential.revoked', {
              credentialId: own.id,
              credentialKind: own.kind,
              subject: context.principal.personId,
              by: 'logout',
            })
          }
        }
        return ok
      }),
    },
    acl: aclProcedures(options.access),
    admin: {
      sessions: sessions.admin,
      presence: adminPresenceProcedures({ service: options.parietal, people: options.people }),
      notice: adminNoticeProcedures({ delivery: options.delivery, people: options.people }),
      auth: {
        policy: authPolicyProcedures({
          policies: options.policies,
          proxy: () => effectiveNetwork(config, settings).proxy,
        }),
        local: authLocalProcedures({
          local: options.local,
          people: options.people,
          policies: options.policies,
          secretKinds: (personId) => options.secretKinds(personId),
        }),
      },
      people: peopleProcedures(
        options.people,
        options.peopleSecrets,
        options.grants,
        options.aliases,
        options.exporter,
      ),
      groups: groupsProcedures(options.groups),
      succession: options.succession,
      reviews: reviewProcedures(options.reviews),
      ...pluginProcedures(options.plugins, options.capabilityRegistry, options.views),
      ...guestProcedures(options.guests),
      audit: {
        list: rpc.admin.audit.list.handler(({ input }) => options.audit.list(input.limit ?? 50)),
        mine: rpc.admin.audit.mine.handler(async ({ input, context }) => {
          const { principal } = context
          let personId = principal.personId
          if (input.person !== undefined && input.person !== principal.personId) {
            if (principal.role !== 'owner')
              throw new ORPCError('FORBIDDEN', {
                message: 'only the owner may read the lines of another person',
              })
            try {
              personId = (await options.people.get(input.person)).id
            } catch (error) {
              if (error instanceof PeopleError)
                throw new ORPCError(error.code, { message: error.message })
              throw error
            }
          }
          const names = new Map((await options.people.list()).map((p) => [p.id, p.name]))
          const nameOf = (actor: string) =>
            actor === 'system' ? 'Keith' : (names.get(actor) ?? 'someone')
          return listMine(options.audit, personId, input, nameOf)
        }),
        notice: {
          get: rpc.admin.audit.notice.get.handler(({ context }) => ({
            notice: AUDIT_PRIVACY_NOTICE,
            text: AUDIT_PRIVACY_NOTICE_TEXT,
            seen: settings.get(noticeKey(context.principal.personId)) !== undefined,
          })),
          ack: rpc.admin.audit.notice.ack.handler(({ context }) => {
            const { personId } = context.principal
            // once per person, whatever device answers: the second ack changes and records nothing
            if (settings.get(noticeKey(personId)) === undefined) {
              settings.set(noticeKey(personId), Date.now())
              context.record('person.notice.seen', {
                notice: AUDIT_PRIVACY_NOTICE,
                subject: personId,
              })
            }
            return ok
          }),
        },
        retention: {
          get: rpc.admin.audit.retention.get.handler(({ context }) => {
            ownerOnly(context.principal.role)
            return retention()
          }),
          set: rpc.admin.audit.retention.set.handler(({ input, context }) => {
            ownerOnly(context.principal.role)
            const from = options.auditRetention.days()
            options.auditRetention.setDays(input.days)
            context.record('audit.retention.set', { from, to: input.days })
            return retention()
          }),
        },
      },
      approvals: {
        get: rpc.admin.approvals.get.handler(() => approvalsView()),
        set: rpc.admin.approvals.set.handler(({ input, context }) => {
          let changes: ReturnType<typeof approvals.set>
          try {
            changes = approvals.set(input)
          } catch (error) {
            if (error instanceof RangeError)
              throw new ORPCError('BAD_REQUEST', { message: error.message })
            throw error
          }
          for (const change of changes) context.record('settings.approvals.set', change)
          return approvalsView()
        }),
      },
      devices: {
        list: rpc.admin.devices.list.handler(({ context }) => ({
          pending: devices.listPending().map(({ id, label, ip, createdAt, expiresAt }) => ({
            id,
            label,
            ip,
            createdAt,
            expiresAt,
          })),
          devices: credentials
            .list(context.principal.personId, 'device')
            .map(({ id, label, createdAt, lastSeenAt, lastIp, revokedAt }) => ({
              id,
              label,
              createdAt,
              lastSeenAt,
              lastIp,
              revokedAt,
            })),
        })),
        approve: rpc.admin.devices.approve.handler(({ input, context }) =>
          deviceLogin
            .approve({
              code: input.code,
              label: input.label,
              personId: context.principal.personId,
              via: context.via,
            })
            .catch(notFound),
        ),
        deny: rpc.admin.devices.deny.handler(async ({ input, context }) => {
          await deviceLogin
            .deny({ code: input.code, actor: context.principal.personId, via: context.via })
            .catch(notFound)
          return ok
        }),
        revoke: rpc.admin.devices.revoke.handler(({ input, context }) => {
          // a member revokes their own credentials only; any other id is not there for them
          const found = credentials.find(input.id)
          if (
            !mayRevoke(context.principal, found?.personId) ||
            !credentials.revoke(input.id, 'device', 'admin')
          ) {
            throw new ORPCError('NOT_FOUND', { message: `no live device ${input.id}` })
          }
          context.record('credential.revoked', {
            credentialId: input.id,
            credentialKind: 'device',
            subject: found?.personId ?? context.principal.personId,
            by: 'admin',
          })
          return ok
        }),
      },
      access: {
        get: rpc.admin.access.get.handler(() => access()),
        set: rpc.admin.access.set.handler(({ input }) => {
          const net = effectiveNetwork(config, settings)
          const url = input.publicUrl === undefined ? net.publicUrl : (input.publicUrl ?? undefined)
          settings.set(SETTING.accessMode, input.mode)
          if (url === undefined) settings.delete(SETTING.accessPublicUrl)
          else settings.set(SETTING.accessPublicUrl, url.replace(/\/+$/, ''))
          settings.set(SETTING.accessHost, input.host ?? deriveBindHost(input.mode, url))
          if (input.proxy !== undefined) settings.set(SETTING.accessProxy, input.proxy)
          return access()
        }),
      },
      tokens: {
        list: rpc.admin.tokens.list.handler(({ context }): TokenInfo[] => {
          const personId = context.principal.personId
          const modern = credentials.list(personId, 'token').map((c) => ({
            id: c.id,
            label: c.label,
            personId: c.personId,
            createdAt: c.createdAt,
            revokedAt: c.revokedAt,
            legacy: false,
            lastSeenAt: c.lastSeenAt,
          }))
          const legacy = tokens
            .list(personId)
            .map((t) => ({ ...t, legacy: true, lastSeenAt: null }))
          return [...modern, ...legacy].sort((a, b) => b.createdAt - a.createdAt)
        }),
        create: rpc.admin.tokens.create.handler(async ({ input, context }) => {
          const created = await createCredential(credentials, {
            personId: context.principal.personId,
            kind: 'token',
            label: input.label,
          })
          context.record('credential.created', {
            credentialId: created.id,
            credentialKind: 'token',
            subject: context.principal.personId,
            label: input.label,
          })
          return created
        }),
        revoke: rpc.admin.tokens.revoke.handler(({ input, context }) => {
          const { principal } = context
          const found = credentials.find(input.id)
          // the credential's owner is known; a legacy token is looked up among the caller's own
          const ownLegacy =
            principal.role === 'owner' ||
            tokens.list(principal.personId).some((t) => t.id === input.id)
          if (found !== undefined && !mayRevoke(principal, found.personId))
            throw new ORPCError('NOT_FOUND', { message: `no live token ${input.id}` })
          const legacy = found === undefined || !credentials.revoke(input.id, 'token', 'admin')
          if (legacy && (!ownLegacy || !tokens.revoke(input.id))) {
            throw new ORPCError('NOT_FOUND', { message: `no live token ${input.id}` })
          }
          context.record('credential.revoked', {
            credentialId: input.id,
            credentialKind: legacy ? 'legacy' : 'token',
            subject: found?.personId ?? principal.personId,
            by: 'admin',
          })
          return ok
        }),
      },
    },
  }
}
