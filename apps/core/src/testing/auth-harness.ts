import { rmSync } from 'node:fs'
import type { AccessProxy, AuthPolicy } from '@keith/contracts'
import {
  auditRepo,
  credentialsRepo,
  type IdentifiersRepo,
  identifiersRepo,
  openDatabase,
  type Sqlite,
  secretsRepo,
  sqlitePersonStore,
  tokensRepo,
} from '@keith/db'
import { createAudit } from '../modules/audit/index.ts'
import { createHasher, type HasherOptions } from '../modules/auth/hasher.ts'
import { type AuthRoutes, createAuthRoutes, type Peer } from '../modules/auth/login.ts'
import { createPrincipalResolver } from '../modules/auth/principal.ts'
import { ensureOwner } from '../modules/auth/tokens.ts'
import type { LanNets } from '../modules/auth/zone.ts'
import {
  type AliasesService,
  createAliasesService,
  createPeopleService,
  createSecretsService,
} from '../modules/people/index.ts'
import { migrateAll } from './migrate-all.ts'

export const FAST = { memoryCost: 1024, timeCost: 1 }
export const LOOP: Peer = { via: 'tcp', ip: '127.0.0.1', forwarded: false }
/** Built at runtime: scanners flag secret-looking literals. */
export const PASS = (n: string) => `purple ${Bun.hash(n)} tractors orbit mars slowly`
export const PIN = '482915'

export const dirs: string[] = []
export const opened: Sqlite[] = []
/** Call from `afterEach`: close databases and delete temp folders. */
export function cleanup(): void {
  for (const db of opened.splice(0)) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export interface Harness {
  sqlite: Sqlite
  routes: AuthRoutes
  clock: { t: number }
  setProxy(p: AccessProxy): void
  people: ReturnType<typeof createPeopleService>
  secrets: ReturnType<typeof createSecretsService>
  aliases: AliasesService
  identifiers: IdentifiersRepo
  /** Test seam: the LAN subnets the core would compute. */
  setLan(lan: LanNets | undefined): void
  credentials: ReturnType<typeof credentialsRepo>
  resolver: ReturnType<typeof createPrincipalResolver>
  events(kind?: string): ReturnType<ReturnType<typeof auditRepo>['list']>
}

export function harness(
  options: {
    file?: string
    insecure?: boolean
    engine?: HasherOptions['engine']
    policy?: () => AuthPolicy
  } = {},
): Harness {
  const sqlite = openDatabase(options.file ?? ':memory:')
  opened.push(sqlite)
  migrateAll(sqlite)
  const clock = { t: 1_800_000_000_000 }
  const now = () => clock.t
  const tokens = tokensRepo(sqlite)
  ensureOwner(tokens)
  const credentials = credentialsRepo(sqlite, { now })
  const secrets = secretsRepo(sqlite)
  const audit = auditRepo(sqlite)
  const recorder = createAudit(audit)
  const hasher = createHasher(
    options.engine === undefined ? FAST : { ...FAST, engine: options.engine },
  )
  let proxy: AccessProxy = 'none'
  let lan: LanNets | undefined
  const identifiers = identifiersRepo(sqlite)
  const revoke = (id: string) => credentials.revokeAll(id) + tokens.revokeAll(id)
  const people = createPeopleService({
    store: sqlitePersonStore(sqlite),
    now,
    revoke,
    hasSecret: (personId) => secrets.kinds(personId).length > 0,
    audit: recorder,
    signIn: identifiers,
  })
  return {
    sqlite,
    clock,
    people,
    credentials,
    secrets: createSecretsService({
      people,
      secrets,
      hasher,
      audit: recorder,
      revoke,
      revokePinSessions: (id) => credentials.revokeMethod(id, 'pin', 'pin-changed'),
    }),
    aliases: createAliasesService({ people, identifiers, audit: recorder, now }),
    identifiers,
    setLan: (l) => {
      lan = l
    },
    routes: createAuthRoutes({
      secrets,
      credentials,
      hasher,
      audit: recorder,
      proxy: () => proxy,
      insecure: options.insecure === true,
      identifiers,
      lan: () => lan,
      ...(options.policy === undefined ? {} : { policy: options.policy }),
      now,
    }),
    setProxy: (p) => {
      proxy = p
    },
    resolver: createPrincipalResolver(tokens, credentials, { now }),
    events: (kind) => audit.list(500).filter((e) => kind === undefined || e.kind === kind),
  }
}

export const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('http://localhost/auth/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
export const caller = { actor: 'owner', via: 'local' as const }

export async function member(h: Harness, username = 'ana') {
  await h.people.add({ username }, caller)
  await h.secrets.setPassword(username, PASS(username), caller)
}
export const login = (h: Harness, username: string, password: string, peer: Peer = LOOP) =>
  h.routes.login(post({ username, password }), peer)
