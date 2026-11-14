import { createCapabilityRegistry, type IdentityChangedReason } from '@keith/contracts'
import {
  auditRepo,
  type CredentialsRepo,
  credentialsRepo,
  grantsRepo,
  identifiersRepo,
  type Sqlite,
  secretsRepo,
  sqliteAcl,
  sqlitePersonStore,
  type TokensRepo,
  tokensRepo,
} from '@keith/db'
import { createAccessService, createGroupsService, createKindTable } from './modules/acl/index.ts'
import { createAclAudit, createAudit } from './modules/audit/index.ts'
import {
  createCapabilities,
  createHasher,
  ensureOwner,
  type HasherOptions,
} from './modules/auth/index.ts'
import { ROOM_KIND, ROOM_KIND_DEF } from './modules/corpus-callosum/index.ts'
import {
  createAliasesService,
  createGrantsService,
  createPeopleService,
  createPersonExport,
  createRemoval,
  createSecretsService,
} from './modules/people/index.ts'
import { createOpenStreams, type OpenStreamsOptions } from './modules/thalamus/index.ts'

/**
 * Wire who may do what: tokens and credentials, the audit log, the people directory with its
 * secrets and grants, and the capability lookup (role table plus grants). No logic here.
 */
export function createIdentity(
  sqlite: Sqlite,
  options: {
    hasher?: HasherOptions
    warn: (m: string) => void
    streamSweepMs?: number
    /** Where removed people's data is kept, and for how long (ADR-0027 §26). */
    removal: { dataDir: string; keepMs: number }
  },
) {
  const tokensBase = tokensRepo(sqlite)
  const credentialsBase = credentialsRepo(sqlite)
  const auditLog = auditRepo(sqlite)
  const audit = createAudit(auditLog, options.warn)
  ensureOwner(tokensBase)
  const secrets = secretsRepo(sqlite)
  const grantsStore = grantsRepo(sqlite)
  const identifiers = identifiersRepo(sqlite)
  const hasher = createHasher(options.hasher)
  // open streams (docs/specs/thalamus.md): every access change closes the person's streams and tells
  // the listeners (the core writes `identity.changed` on the person's front session)
  const listeners = new Set<(change: { personId: string; reason: IdentityChangedReason }) => void>()
  // the re-check reads the people service and the repos, which are built below
  let stillAllowed: NonNullable<OpenStreamsOptions['stillAllowed']> = () => true
  const streams = createOpenStreams({
    stillAllowed: (facts) => stillAllowed(facts),
    ...(options.streamSweepMs === undefined ? {} : { sweepMs: options.streamSweepMs }),
    warn: options.warn,
  })
  const tell = (personId: string, reason: IdentityChangedReason): void => {
    for (const listener of listeners) {
      try {
        listener({ personId, reason })
      } catch (error) {
        options.warn(`identity.changed listener failed: ${String(error)}`)
      }
    }
  }
  const accessChanged = (personId: string, reason: IdentityChangedReason): void => {
    streams.closePerson(personId)
    tell(personId, reason)
  }
  // every revoke of a credential or token, from any call site, closes its open streams
  const tokens: TokensRepo = {
    ...tokensBase,
    revoke(id) {
      const revoked = tokensBase.revoke(id)
      if (revoked) streams.closeCredential(id)
      return revoked
    },
    revokeAll(personId) {
      const count = tokensBase.revokeAll(personId)
      if (count > 0) streams.closePerson(personId)
      return count
    },
  }
  const credentials: CredentialsRepo = {
    ...credentialsBase,
    revoke(id, kind, reason) {
      const personId = credentialsBase.find(id)?.personId
      const revoked = credentialsBase.revoke(id, kind, reason)
      if (revoked) {
        streams.closeCredential(id)
        if (personId !== undefined) tell(personId, 'credential')
      }
      return revoked
    },
    revokeAll(personId, reason) {
      const count = credentialsBase.revokeAll(personId, reason)
      if (count > 0) accessChanged(personId, 'credential')
      return count
    },
    revokeMethod(personId, method, reason) {
      const count = credentialsBase.revokeMethod(personId, method, reason)
      if (count > 0) accessChanged(personId, 'credential')
      return count
    },
  }
  const revokeSessions = (personId: string): number => {
    const count = credentialsBase.revokeAll(personId) + tokensBase.revokeAll(personId)
    streams.closePerson(personId)
    return count
  }
  /** A password change or reset: the sessions end and the person is told (`credential`). */
  const revokeAndTell = (personId: string): number => {
    const count = revokeSessions(personId)
    accessChanged(personId, 'credential')
    return count
  }
  // resources: kinds are registered by plugins (P16); a person who is removed hands theirs to the owner
  // inside the delete transaction (docs/specs/people.md)
  const kinds = createKindTable()
  // the shared-room transcript (docs/specs/corpus-callosum.md, "ACL"): core owns this kind, nothing else registers it
  kinds.register(ROOM_KIND, ROOM_KIND_DEF)
  const acl = sqliteAcl(sqlite, { kinds })
  const aclAudit = createAclAudit({ audit, warn: options.warn })
  // a removed person's memory, workspace and conversations are kept first (people/removed.ts)
  const removal = createRemoval({
    dataDir: options.removal.dataDir,
    keepMs: options.removal.keepMs,
    sqlite,
    audit,
  })
  const people = createPeopleService({
    removal,
    store: sqlitePersonStore(sqlite, {
      beforeDelete: (personId, heirId) => {
        const moved = acl.removePerson(personId, heirId)
        if (moved > 0)
          audit.record({
            kind: 'person.resources.moved',
            actor: 'system',
            via: 'local',
            detail: { personId, subject: personId, heirId, count: moved },
          })
      },
    }),
    revoke: revokeSessions,
    onAccessChanged: accessChanged,
    hasSecret: (personId) => secrets.kinds(personId).length > 0,
    audit,
    signIn: identifiers,
  })
  // capabilities: the core ids plus the ones plugins register at load (docs/specs/plugins.md)
  const capabilityRegistry = createCapabilityRegistry()
  const capabilities = createCapabilities(grantsStore, capabilityRegistry)
  stillAllowed = async (facts) => {
    const person = await people.get(facts.personId).catch(() => undefined)
    if (person === undefined || person.status !== 'active' || person.role !== facts.role)
      return false
    const key = [...capabilities.of({ personId: person.id, role: person.role })].sort().join(',')
    if (key !== facts.grantsKey) return false
    if (facts.credentialId === undefined) return true
    const now = Date.now()
    if (facts.credentialKind === 'legacy')
      return tokensBase
        .list(person.id)
        .some((t) => t.id === facts.credentialId && t.revokedAt === null)
    const found = credentialsBase.find(facts.credentialId)
    return (
      found !== undefined &&
      found.revokedAt === null &&
      (found.absoluteExpiresAt === null || found.absoluteExpiresAt > now) &&
      (found.idleExpiresAt === null || found.idleExpiresAt > now)
    )
  }
  const groups = createGroupsService({ acl, people, audit: aclAudit })
  const access = createAccessService({ acl, kinds, people, groups, audit: aclAudit })
  return {
    access,
    removal,
    exporter: createPersonExport({ dataDir: options.removal.dataDir, people, removal, audit }),
    kinds,
    acl,
    aclAudit,
    groups,
    tokens,
    credentials,
    auditLog,
    audit,
    secrets,
    hasher,
    people,
    peopleSecrets: createSecretsService({
      people,
      secrets,
      hasher,
      audit,
      revoke: revokeAndTell,
      revokePinSessions: (personId) => credentials.revokeMethod(personId, 'pin', 'pin-changed'),
    }),
    identifiers,
    aliases: createAliasesService({ people, identifiers, audit }),
    grants: createGrantsService({
      people,
      grants: grantsStore,
      audit,
      registry: capabilityRegistry,
      onAccessChanged: accessChanged,
    }),
    capabilityRegistry,
    capabilities,
    streams,
    /** Subscribe to access changes (the core writes `identity.changed`); returns the unsubscribe. */
    onIdentityChanged(
      listener: (change: { personId: string; reason: IdentityChangedReason }) => void,
    ): () => void {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
}
