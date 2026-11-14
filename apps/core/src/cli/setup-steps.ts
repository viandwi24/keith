// The logic of `keith-core setup` without a front end: validation, defaults, saving through the
// offline admin and the provider test. The line-prompt flow (setup.ts) and the full-screen wizard
// (setup-wizard.tsx) both call it, so they save the same settings.
import { userInfo } from 'node:os'
import {
  type AccessMode,
  PRIMARY_MODEL_ROLES,
  type PrimaryModelRole,
  parseUsdLimit,
  USERNAME_MESSAGE,
  USERNAME_RE,
} from '@keith/contracts'
import { secretsRepo } from '@keith/db'
import {
  deriveBindHost,
  effectiveNetwork,
  type OfflineAdmin,
  ownerName,
  SETTING,
} from '../modules/admin/index.ts'
import {
  checkPassword,
  checkPin,
  createHasher,
  ensureOwner,
  type Hasher,
} from '../modules/auth/index.ts'
import { DEFAULT_MONTHLY_LIMIT_USD } from '../modules/budget/index.ts'
import { PROVIDER_DEFAULTS, type ProviderService } from '../modules/providers/index.ts'
import type { Config } from '../platform/config.ts'
import { money } from './prompt-helpers.ts'

export const ENV_KEYS: Record<string, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
}
/** The providers setup offers (anything else is added later with `keith-core provider add`). */
export const SETUP_PROVIDERS = ['openrouter', 'openai', 'deepseek'] as const
export const PROBE_ID = 'setup-probe'
export const NAME_MAX = 60

export const nonEmpty = (v: string): string | undefined =>
  v === '' ? 'a value is needed' : undefined

export const isUrl = (v: string): boolean => {
  try {
    new URL(v)
    return true
  } catch {
    return false
  }
}

export const urlProblem = (v: string): string | undefined =>
  v === '' || isUrl(v) ? undefined : 'expected a URL such as https://mac.tailnet.ts.net'

export const budgetProblem = (v: string): string | undefined => {
  const p = parseUsdLimit(v)
  return typeof p === 'string' ? p : undefined
}

export const nameProblem = (v: string): string | undefined =>
  v.trim() === ''
    ? 'a name is needed'
    : v.trim().length > NAME_MAX
      ? `at most ${NAME_MAX} characters`
      : undefined

export function safeUser(): string {
  try {
    return userInfo().username
  } catch {
    return 'Owner'
  }
}

// ---- name

/** Make sure the owner exists; the name they have now, if any. */
export function currentOwnerName(admin: OfflineAdmin): string | undefined {
  ensureOwner(admin.tokens)
  return ownerName(admin.tokens, admin.settings)
}

/**
 * Rename the current owner (the person with the owner role, whatever their id after a transfer). Goes through
 * the people service, so the change is checked and audited like the username (FD13-03).
 */
export async function saveOwnerName(admin: OfflineAdmin, name: string): Promise<void> {
  ensureOwner(admin.tokens)
  const owner = admin.tokens.owner()
  if (owner === undefined || owner.name === name) return
  await admin.people.rename(owner.id, { name }, { actor: 'system', via: 'offline' })
}

/**
 * One audit row for a change made by setup. Offline setup has no caller, so the actor is the
 * system and the listener is `offline` (docs/specs/auth.md Audit). Never a key or a secret.
 */
export function recordSetup(
  admin: OfflineAdmin,
  kind: string,
  detail: Record<string, unknown>,
): void {
  admin.audit.add({ kind, actor: 'system', via: 'offline', detail })
}

// ---- provider

export interface ProviderProbe {
  ok: boolean
  message?: string | undefined
  /** Model ids the provider lists (only when asked for and the test worked). */
  models?: string[]
}

/**
 * Test a provider. A new key goes in under a probe id first, so nothing real is written until it
 * works; the probe is always removed. An existing connection (`useExisting`) is tested in place.
 */
export async function probeProvider(
  providers: ProviderService,
  input: {
    pid: string
    settings?: { apiKey: string } | undefined
    useExisting: boolean
    listModels?: boolean
  },
): Promise<ProviderProbe> {
  const { pid, settings, useExisting } = input
  const testId = useExisting ? pid : PROBE_ID
  let result: ProviderProbe
  try {
    if (!useExisting) {
      await providers.put({
        id: PROBE_ID,
        providerId: pid,
        ...(settings === undefined ? {} : { settings }),
      })
    }
    result = await providers.test(testId)
    if (result.ok && input.listModels === true) {
      try {
        result = { ...result, models: (await providers.models(testId)).map((m) => m.id) }
      } catch {
        // the ids are then not checked
      }
    }
  } catch (error) {
    result = { ok: false, message: error instanceof Error ? error.message : String(error) }
  } finally {
    if (!useExisting) await providers.remove(PROBE_ID).catch(() => undefined)
  }
  return result
}

/**
 * Save the connection of `pid`: a new one (`settings.provider.add`), or a new key for the existing
 * one (`settings.provider.key`, never the key itself). The same kinds as the RPC (platform/rpc.ts).
 */
export async function putProvider(
  admin: OfflineAdmin,
  input: { pid: string; exists: boolean; settings?: { apiKey: string } | undefined },
): Promise<void> {
  const settings = input.settings === undefined ? {} : { settings: input.settings }
  if (input.exists) {
    if (input.settings === undefined) return
    const saved = await admin.providers.put({ id: input.pid, ...settings })
    recordSetup(admin, 'settings.provider.key', { connection: saved.id })
    return
  }
  const saved = await admin.providers.put({ providerId: input.pid, ...settings })
  recordSetup(admin, 'settings.provider.add', { connection: saved.id, provider: input.pid })
}

/** Set the model of a role (`settings.model.set`). */
export async function saveRole(
  admin: OfflineAdmin,
  role: PrimaryModelRole,
  ref: string,
): Promise<void> {
  await admin.providers.setRole(role, ref)
  recordSetup(admin, 'settings.model.set', { role, ref })
}

// ---- models

export const ROLES = PRIMARY_MODEL_ROLES
export const ROLE_LABEL: Record<PrimaryModelRole, string> = { front: 'Front', cortex: 'Cortex' }

/**
 * The model id offered for a role: the saved one of this connection, else the provider default.
 * `providerId` is the provider of the connection (the connection may not be saved yet).
 */
export async function modelSuggestion(
  providers: ProviderService,
  input: { connection: string; providerId: string | undefined; role: PrimaryModelRole },
): Promise<string | undefined> {
  const { connection, providerId, role } = input
  const stored = (await providers.roles())[role]
  return stored?.startsWith(`${connection}:`) === true
    ? stored.slice(connection.length + 1)
    : (PROVIDER_DEFAULTS[providerId ?? '']?.[role] ??
        (await providers.describe()).find((d) => d.id === providerId)?.defaultModel)
}

/** Model ids of a saved connection, or undefined when the provider cannot list them. */
export async function knownModels(
  providers: ProviderService,
  connection: string,
): Promise<string[] | undefined> {
  try {
    return (await providers.models(connection)).map((m) => m.id)
  } catch {
    return undefined
  }
}

export function modelChecker(
  connection: string,
  known: readonly string[],
): (v: string) => string | undefined {
  return (v) => {
    if (v === '') return 'a model id is needed'
    const id = v.startsWith(`${connection}:`) ? v.slice(connection.length + 1) : v
    return known.length > 0 && !known.includes(id)
      ? `unknown model ${id} (see keith-core model list)`
      : undefined
  }
}

export const modelRef = (connection: string, value: string): string =>
  value.startsWith(`${connection}:`) ? value : `${connection}:${value}`

// ---- budget

/** The text the budget question starts with. */
export function budgetDefault(admin: OfflineAdmin): string {
  const current = admin.budget.status().limitUsd
  return current === null && admin.settings.get('budget.seeded') === true
    ? 'none'
    : money(current ?? DEFAULT_MONTHLY_LIMIT_USD)
}

/**
 * The limit a headless run keeps when no `--budget` is given: the current one. A limit the owner
 * removed (null after the ledger was seeded) stays removed; the default applies only before that.
 */
export function budgetHeadless(admin: OfflineAdmin): number | null {
  const current = admin.budget.status().limitUsd
  if (current !== null) return current
  return admin.settings.get('budget.seeded') === true ? null : DEFAULT_MONTHLY_LIMIT_USD
}

export function saveBudget(admin: OfflineAdmin, limit: number | null): void {
  admin.budget.set(limit)
  recordSetup(admin, 'settings.budget.set', { limitUsd: limit })
}

// ---- access

/** Save access mode, bind host and public URL; returns the one-line summary. */
export function saveAccess(
  admin: OfflineAdmin,
  input: { mode: AccessMode; publicUrl: string | undefined; bind?: string | undefined },
): string {
  const { mode, publicUrl } = input
  const host = input.bind ?? deriveBindHost(mode, publicUrl)
  admin.settings.set(SETTING.accessMode, mode)
  admin.settings.set(SETTING.accessHost, host)
  if (publicUrl === undefined) admin.settings.delete(SETTING.accessPublicUrl)
  else admin.settings.set(SETTING.accessPublicUrl, publicUrl.replace(/\/+$/, ''))
  recordSetup(admin, 'settings.access.set', {
    mode,
    host,
    publicUrl: admin.settings.get<string>(SETTING.accessPublicUrl) ?? null,
  })
  return mode === 'local'
    ? `only this computer (${host})`
    : `remote, bind ${host}${publicUrl === undefined ? '' : `, ${publicUrl}`}`
}

export const currentNetwork = (config: Config, admin: OfflineAdmin) =>
  effectiveNetwork(config, admin.settings)

// ---- owner PIN

/** Setting a secret offline ends every session the person has: a leaked one dies when the secret is rotated. */
function revokeOwnerSessions(admin: OfflineAdmin, personId: string, reason: string): void {
  const count = admin.credentials.revokeAll(personId, reason)
  if (count === 0) return
  admin.audit.add({
    kind: 'person.sessions.revoked',
    actor: 'system',
    via: 'offline',
    detail: { personId, subject: personId, reason, count },
  })
}

/** Set the owner's step-up PIN (rules of `checkPin`); returns the problem, or undefined when saved. */
export async function saveOwnerPin(
  admin: OfflineAdmin,
  pin: string,
  hasher: Hasher = createHasher(),
): Promise<string | undefined> {
  const problem = checkPin(pin)
  if (problem !== undefined) return problem
  ensureOwner(admin.tokens)
  const owner = admin.tokens.owner()
  if (owner === undefined) return 'no owner yet'
  secretsRepo(admin.sqlite).set(owner.id, 'pin', await hasher.hash(pin), Date.now())
  revokeOwnerSessions(admin, owner.id, 'pin-set')
  admin.audit.add({
    kind: 'person.secret.set',
    actor: 'system',
    via: 'offline',
    detail: { personId: owner.id, subject: owner.id, kind: 'pin' },
  })
  return undefined
}

/** The owner's sign-in methods set now (`pin`, `password`); creates the owner row when there is none. */
export function ownerSignInKinds(admin: OfflineAdmin): string[] {
  ensureOwner(admin.tokens)
  const owner = admin.tokens.owner()
  return owner === undefined ? [] : [...secretsRepo(admin.sqlite).kinds(owner.id)].sort()
}

/** Set the owner's password (rules and blocklist of `checkPassword`); the problem, or undefined when saved. */
export async function saveOwnerPassword(
  admin: OfflineAdmin,
  password: string,
  hasher: Hasher = createHasher(),
): Promise<string | undefined> {
  ensureOwner(admin.tokens)
  const owner = admin.tokens.owner()
  if (owner === undefined) return 'no owner yet'
  const problem = checkPassword(password, { username: owner.username, name: owner.name })
  if (problem !== undefined) return problem
  secretsRepo(admin.sqlite).set(owner.id, 'password', await hasher.hash(password), Date.now())
  revokeOwnerSessions(admin, owner.id, 'password-set')
  admin.audit.add({
    kind: 'person.secret.set',
    actor: 'system',
    via: 'offline',
    detail: { personId: owner.id, subject: owner.id, kind: 'password' },
  })
  return undefined
}

/** The username the owner signs in with: 2-32 of a-z 0-9 . _ - (same rule as `people add`). */
export const usernameProblem = (v: string): string | undefined =>
  USERNAME_RE.test(v) ? undefined : USERNAME_MESSAGE

/** The username the owner signs in with now (`owner` until it is changed). */
export function currentOwnerUsername(admin: OfflineAdmin): string {
  ensureOwner(admin.tokens)
  return admin.tokens.owner()?.username ?? 'owner'
}

/**
 * The rule for the owner's username: its format, and a name no other person has. Built once before
 * anything is saved, so a refusal changes nothing (FD10-03).
 */
export async function ownerUsernameChecker(
  admin: OfflineAdmin,
): Promise<(username: string) => string | undefined> {
  const owner = admin.tokens.owner()
  const others = new Set(
    (await admin.people.list())
      .filter((p) => p.id !== owner?.id)
      .map((p) => p.username)
      .filter((u): u is string => u !== null),
  )
  return (username) =>
    usernameProblem(username) ??
    (others.has(username) ? `the username ${username} is taken` : undefined)
}

/**
 * Rename the current owner through the people service: the rules and the uniqueness check of
 * `people rename`, and an audit row with `via: offline` (ADR-0027 §7, §24). Never a raw UPDATE.
 */
export async function saveOwnerUsername(admin: OfflineAdmin, username: string): Promise<void> {
  ensureOwner(admin.tokens)
  const owner = admin.tokens.owner()
  if (owner === undefined || owner.username === username) return
  await admin.people.rename(owner.id, { username }, { actor: 'system', via: 'offline' })
}

/** The setup event of the owner's sign-in (which methods, never the secrets). */
export function recordOwnerSignIn(admin: OfflineAdmin, kinds: string[]): void {
  const owner = admin.tokens.owner()
  admin.audit.add({
    kind: 'setup.owner_signin',
    actor: 'system',
    via: 'offline',
    detail: { personId: owner?.id ?? 'owner', methods: kinds },
  })
}

// ---- done

export function markSetupDone(admin: OfflineAdmin): void {
  admin.settings.set(SETTING.setupDone, true)
  admin.settings.set('setup.completedAt', Date.now())
  recordSetup(admin, 'setup.done', {})
}

export interface SetupSummary {
  owner: string
  connection: string | undefined
  models: Record<PrimaryModelRole, string> | undefined
  budget: number | null
  access: string
  /** How the owner signs in (`pin`, `password`). */
  signIn?: string[]
}

/** The "Saved for ..." block, one line per fact (the same text from both front ends). */
export function summaryLines(s: SetupSummary): string[] {
  const lines = [
    `\nSaved for ${s.owner}.\n`,
    `  provider  ${s.connection ?? 'none yet (keith-core provider add)'}\n`,
  ]
  if (s.models !== undefined)
    lines.push(`  front     ${s.models.front}\n  cortex    ${s.models.cortex}\n`)
  lines.push(`  budget    ${s.budget === null ? 'no limit' : `${money(s.budget)} USD / month`}\n`)
  lines.push(`  access    ${s.access}\n`)
  if (s.signIn !== undefined) lines.push(`  sign-in   ${s.signIn.join(' + ')}\n`)
  return lines
}

export const NEXT_STEPS = [
  'keith-core start            run core (it keeps running; use another terminal for the rest)',
  'keith                       chat on this machine (sign in with the owner PIN); other devices: keith login --core <url>',
  'keith-core pair             print the command that joins a node',
  'keith-core doctor           check that everything is in order',
]
