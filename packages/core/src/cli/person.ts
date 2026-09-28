// `keith person …`: the owner brings people into Keith from the host (phase 5). See
// docs/architecture/nodes.md#adding-people, docs/architecture/config.md#keith-person, ADR-0017 and
// ADR-0018. `runPersonCommand` opens `KEITH_HOME`; `runPerson` holds the logic and takes the
// repositories, config, paths and clock as arguments, so tests inject fakes.

import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { isKeithError, KeithError } from '@keith/sdk'
import { PERSON_NAME_MAX_CHARS } from '../builtins/relay.ts'
import { keithPaths, parseConfig } from '../config/index.ts'
import type { KeithConfig, KeithPaths } from '../config/types.ts'
import { createIds, sha256Hex, systemClock, withHomeLock } from '../shared/index.ts'
import type { Clock, Ids, PersonId, Tier } from '../shared/types.ts'
import { openDb } from '../storage/index.ts'
import type { PersonRecord, PersonRemoval, RelationshipRecord, Repositories } from '../storage/types.ts'
import { isInside } from './backup.ts'
import { type Prompter, terminalPrompter } from './prompt.ts'

/** What `keith person` needs from the CLI (a subset of `CliIo`). */
export type PersonCommandIo = {
  env: Record<string, string | undefined>
  out: (line: string) => void
  err: (line: string) => void
  /** Only `remove` asks (its confirmation). Default: the terminal. */
  prompter?: Prompter | undefined
  clock?: Clock | undefined
}

export const PERSON_SUBCOMMANDS = [
  'add',
  'list',
  'invite',
  'tier',
  'card',
  'block',
  'unblock',
  'remove',
] as const
export type PersonSubcommand = (typeof PERSON_SUBCOMMANDS)[number]

export const PERSON_USAGE = `Usage: keith person <command> [options]

Commands:
  add <name> [--tier member|guest]     Create the person, their relationship card and main
                                       thread, and print an invite link (default tier: member)
  list                                 List people: name, tier, username, sign-in, last seen
  invite <name>                        Print a new invite link; revokes older unused ones
  tier <name> <member|guest>           Change a person's tier (never the owner's)
  card <name> [--tone <text>] [--notes <text>]
                                       Show or edit the relationship card
  block <name> --from <other>          Refuse relays from <other> to <name>
  unblock <name> --from <other>        Accept relays from <other> to <name> again
  remove <name> [--yes]                Delete the person and their data (ADR-0018); needs
                                       Keith stopped. Run keith backup first

An invite link is <publicUrl>/#invite=<code> (server.publicUrl, default http://<host>:<port>).
It works once and expires after auth.inviteTtlHours. In the terminal: keith-tui --invite <code>.`

/** Invite codes: 32 random bytes, base64url (43 characters). */
export const INVITE_CODE_BYTES = 32
const MAIN_SLUG = 'main'
const MAIN_TITLE = 'Main'
const HOUR_MS = 3_600_000

/** The repositories `keith person` uses. */
export type PersonRepos = Pick<Repositories, 'persons' | 'relationships' | 'threads' | 'inviteLinks'>

/** The config keys `keith person` reads. */
export type PersonConfig = {
  server: Pick<KeithConfig['server'], 'host' | 'port' | 'publicUrl'>
  auth: Pick<KeithConfig['auth'], 'inviteTtlHours'>
  mind: Pick<KeithConfig['mind'], 'timezone'>
}

/** What `addPerson` and `createInvite` need. */
export type PersonDeps = {
  repos: PersonRepos
  config: PersonConfig
  clock: Clock
  ids: Ids
  /** Default: `crypto.getRandomValues`. */
  randomBytes?: ((n: number) => Uint8Array) | undefined
}

/** Everything `runPerson` needs. `runPersonCommand` builds it from `KEITH_HOME`. */
export type PersonRun = {
  paths: KeithPaths
  clock: Clock
  out: (line: string) => void
  err: (line: string) => void
  /** Only `remove` asks. Default: the terminal. */
  prompter?: Prompter | undefined
  /** Loads the config (only `add`, `invite` and `list` need it). */
  config: () => Promise<PersonConfig>
  /** Opens the repositories. `close` is called when the subcommand ends. */
  open: () => Promise<{ repos: PersonRepos; close(): void }>
  /** Default: `createIds({ clock })`. */
  ids?: Ids | undefined
  randomBytes?: ((n: number) => Uint8Array) | undefined
}

/** A printed invite. `code` appears only in `link` and `tuiCommand`. */
export type Invite = {
  code: string
  link: string
  tuiCommand: string
  expiresAt: number
  /** Older unused links that were revoked. */
  revoked: number
}

/** SHA-256 of the code's UTF-8 bytes, hex (what `invite_links.code_hash` stores and P5-N1 computes). */
export function hashInviteCode(code: string): string {
  return sha256Hex(code)
}

/** `server.publicUrl` without a trailing slash, or `http://<host>:<port>`. */
export function publicUrl(server: PersonConfig['server']): string {
  if (server.publicUrl !== undefined) return server.publicUrl.replace(/\/+$/, '')
  const host = server.host.includes(':') ? `[${server.host}]` : server.host
  return `http://${host}:${server.port}`
}

/** A refusal of `keith person` (bad name, owner, unknown person): printed as it is, exit 1. */
export class PersonCommandRefusal extends Error {
  override name = 'PersonCommandRefusal'
}

function refuse(message: string): PersonCommandRefusal {
  return new PersonCommandRefusal(message)
}

/**
 * Revokes the person's unused invite links, stores a new one (hash only) and returns it. Refuses
 * the owner, whose password `keith setup` resets.
 */
export async function createInvite(deps: PersonDeps, person: PersonRecord): Promise<Invite> {
  if (person.tier === 'owner') {
    throw refuse(`${person.name} is the owner; reset the owner's password with 'keith setup'.`)
  }
  const randomBytes = deps.randomBytes ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)))
  const code = Buffer.from(randomBytes(INVITE_CODE_BYTES)).toString('base64url')
  const revoked = await deps.repos.inviteLinks.revokeFor(person.id)
  const now = deps.clock.now()
  const expiresAt = now + Math.round(deps.config.auth.inviteTtlHours * HOUR_MS)
  await deps.repos.inviteLinks.create({
    codeHash: hashInviteCode(code),
    personId: person.id,
    createdAt: now,
    expiresAt,
    usedAt: null,
  })
  const url = publicUrl(deps.config.server)
  return {
    code,
    link: `${url}/#invite=${code}`,
    tuiCommand: `keith-tui --url ${url} --invite ${code}`,
    expiresAt,
    revoked,
  }
}

/**
 * Creates the person (no username or password yet), an empty relationship card, their main
 * direct thread, and an invite link. Refuses an empty name, one longer than 80 characters, and a
 * name or username someone already has (case-insensitive).
 */
export async function addPerson(
  deps: PersonDeps,
  input: { name: string; tier: Exclude<Tier, 'owner'> },
): Promise<{ person: PersonRecord; invite: Invite }> {
  const name = input.name.trim()
  if (name === '') throw refuse('A name is required.')
  if (name.length > PERSON_NAME_MAX_CHARS) {
    throw refuse(`A name has at most ${PERSON_NAME_MAX_CHARS} characters.`)
  }
  const existing = await deps.repos.persons.findByName(name)
  if (existing !== null) throw refuse(`The name ${name} is taken (by ${existing.name}).`)
  const now = deps.clock.now()
  const person: PersonRecord = {
    id: deps.ids.next('per'),
    name,
    username: null,
    passwordHash: null,
    tier: input.tier,
    lastSeenAt: null,
    createdAt: now,
  }
  await deps.repos.persons.create(person)
  await deps.repos.relationships.upsert({ personId: person.id, tone: '', notes: '', blockedRelayFrom: [] })
  await deps.repos.threads.create(
    {
      id: deps.ids.next('thr'),
      kind: 'direct',
      slug: MAIN_SLUG,
      title: MAIN_TITLE,
      ownerPersonId: person.id,
      summary: null,
      createdAt: now,
      updatedAt: now,
    },
    [person.id],
  )
  const invite = await createInvite(deps, person)
  return { person, invite }
}

/** `YYYY-MM-DD HH:mm` in `timeZone`. */
export function formatTime(at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at))
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

function isSubcommand(value: string): value is PersonSubcommand {
  return (PERSON_SUBCOMMANDS as readonly string[]).includes(value)
}

class UsageError extends Error {}

type Parsed = { positionals: string[]; values: Record<string, string | boolean | undefined> }

const OPTIONS: Record<PersonSubcommand, Record<string, { type: 'string' | 'boolean' }>> = {
  add: { tier: { type: 'string' } },
  list: {},
  invite: {},
  tier: {},
  card: { tone: { type: 'string' }, notes: { type: 'string' } },
  block: { from: { type: 'string' } },
  unblock: { from: { type: 'string' } },
  remove: { yes: { type: 'boolean' } },
}

const POSITIONALS: Record<PersonSubcommand, number> = {
  add: 1,
  list: 0,
  invite: 1,
  tier: 2,
  card: 1,
  block: 1,
  unblock: 1,
  remove: 1,
}

function parse(sub: PersonSubcommand, args: string[]): Parsed {
  let parsed: Parsed
  try {
    parsed = parseArgs({ args, options: OPTIONS[sub], strict: true, allowPositionals: true })
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
  if (parsed.positionals.length !== POSITIONALS[sub]) {
    throw new UsageError(`keith person ${sub} takes ${POSITIONALS[sub]} argument(s)`)
  }
  return parsed
}

function str(parsed: Parsed, key: string): string | undefined {
  const v = parsed.values[key]
  return typeof v === 'string' ? v : undefined
}

function memberOrGuest(value: string | undefined, what: string): Exclude<Tier, 'owner'> {
  if (value === 'member' || value === 'guest') return value
  if (value === 'owner') {
    throw refuse('Keith has exactly one owner; a tier can only be member or guest (ADR-0017).')
  }
  throw new UsageError(`${what} must be member or guest`)
}

async function findPerson(repos: PersonRepos, name: string): Promise<PersonRecord> {
  const person = await repos.persons.findByName(name)
  if (person === null) throw refuse(`No one is called ${name.trim()}. See 'keith person list'.`)
  return person
}

function emptyCard(personId: PersonId): RelationshipRecord {
  return { personId, tone: '', notes: '', blockedRelayFrom: [] }
}

function printInvite(run: PersonRun, config: PersonConfig, invite: Invite): void {
  run.out(
    `Invite link (works once, expires ${formatTime(invite.expiresAt, config.mind.timezone)} ${config.mind.timezone}):`,
  )
  run.out(`  ${invite.link}`)
  run.out('In the terminal:')
  run.out(`  ${invite.tuiCommand}`)
}

/**
 * Runs one `keith person` subcommand (`args[0]` is the subcommand). Returns the exit code: 0 done,
 * 1 refused or failed, 2 usage error.
 */
export async function runPerson(args: string[], run: PersonRun): Promise<number> {
  const [sub, ...rest] = args
  if (sub === undefined || sub === '--help' || sub === '-h' || sub === 'help') {
    run.out(PERSON_USAGE)
    return 0
  }
  if (!isSubcommand(sub)) {
    run.err(`Unknown person command: ${sub}`)
    run.err(PERSON_USAGE)
    return 2
  }
  try {
    const parsed = parse(sub, rest)
    if (sub === 'remove') {
      // ADR-0018: the running core caches participants, so removal needs Keith stopped.
      return await withHomeLock(run.paths.home, () => withRepos(run, (repos) => remove(run, repos, parsed)), {
        clock: run.clock,
      })
    }
    return await withRepos(run, (repos) => dispatch(sub, run, repos, parsed))
  } catch (error) {
    if (error instanceof UsageError) {
      run.err(error.message)
      run.err(PERSON_USAGE)
      return 2
    }
    run.err(isKeithError(error) ? error.message : error instanceof Error ? error.message : String(error))
    return 1
  }
}

async function withRepos<T>(run: PersonRun, fn: (repos: PersonRepos) => Promise<T>): Promise<T> {
  const db = await run.open()
  try {
    return await fn(db.repos)
  } finally {
    db.close()
  }
}

function deps(run: PersonRun, repos: PersonRepos, config: PersonConfig): PersonDeps {
  return {
    repos,
    config,
    clock: run.clock,
    ids: run.ids ?? createIds({ clock: run.clock }),
    randomBytes: run.randomBytes,
  }
}

async function dispatch(
  sub: Exclude<PersonSubcommand, 'remove'>,
  run: PersonRun,
  repos: PersonRepos,
  parsed: Parsed,
): Promise<number> {
  const [first = '', second] = parsed.positionals
  switch (sub) {
    case 'add': {
      const tier = memberOrGuest(str(parsed, 'tier') ?? 'member', '--tier')
      const config = await run.config()
      const { person, invite } = await addPerson(deps(run, repos, config), { name: first, tier })
      run.out(`Added ${person.name} (${person.tier}) with a relationship card and a main thread.`)
      printInvite(run, config, invite)
      return 0
    }
    case 'invite': {
      const person = await findPerson(repos, first)
      const config = await run.config()
      const invite = await createInvite(deps(run, repos, config), person)
      if (invite.revoked > 0) run.out(`Revoked ${invite.revoked} older unused invite link(s).`)
      if (person.username !== null) {
        run.out(
          `${person.name} can sign in as ${person.username}; accepting this link sets a new username and password.`,
        )
      }
      printInvite(run, config, invite)
      return 0
    }
    case 'list':
      return await list(run, repos)
    case 'tier': {
      const tier = memberOrGuest(second, 'The tier')
      const person = await findPerson(repos, first)
      if (person.tier === 'owner')
        throw refuse(`${person.name} is the owner; the owner's tier never changes (ADR-0017).`)
      if (person.tier === tier) {
        run.out(`${person.name} is already a ${tier}.`)
        return 0
      }
      await repos.persons.setTier(person.id, tier)
      run.out(`${person.name} is now a ${tier} (was ${person.tier}).`)
      return 0
    }
    case 'card':
      return await card(run, repos, first, str(parsed, 'tone'), str(parsed, 'notes'))
    case 'block':
    case 'unblock':
      return await blockList(run, repos, sub, first, str(parsed, 'from'))
  }
}

async function list(run: PersonRun, repos: PersonRepos): Promise<number> {
  const people = await repos.persons.list()
  if (people.length === 0) {
    run.out("No people yet. Run 'keith setup' to create the owner.")
    return 0
  }
  const { timezone } = (await run.config()).mind
  const rows = [
    ['NAME', 'TIER', 'USERNAME', 'SIGN-IN', `LAST SEEN (${timezone})`],
    ...people.map((p) => [
      p.name,
      p.tier,
      p.username ?? '-',
      p.username !== null && p.passwordHash !== null ? 'yes' : 'no',
      p.lastSeenAt === null ? '-' : formatTime(p.lastSeenAt, timezone),
    ]),
  ]
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length))) ?? []
  for (const row of rows) {
    run.out(
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
        .join('  ')
        .trimEnd(),
    )
  }
  return 0
}

async function card(
  run: PersonRun,
  repos: PersonRepos,
  name: string,
  tone: string | undefined,
  notes: string | undefined,
): Promise<number> {
  const person = await findPerson(repos, name)
  const current = (await repos.relationships.get(person.id)) ?? emptyCard(person.id)
  let shown = current
  if (tone !== undefined || notes !== undefined) {
    shown = { ...current, ...(tone === undefined ? {} : { tone }), ...(notes === undefined ? {} : { notes }) }
    await repos.relationships.upsert(shown)
    run.out(`Updated the relationship card of ${person.name}.`)
  }
  const blocked: string[] = []
  for (const id of shown.blockedRelayFrom) blocked.push((await repos.persons.get(id))?.name ?? id)
  run.out(`Relationship card of ${person.name} (${person.tier}):`)
  run.out(`  tone:  ${shown.tone === '' ? '-' : shown.tone}`)
  run.out(`  notes: ${shown.notes === '' ? '-' : shown.notes}`)
  run.out(`  relays refused from: ${blocked.length === 0 ? '-' : blocked.join(', ')}`)
  return 0
}

async function blockList(
  run: PersonRun,
  repos: PersonRepos,
  sub: 'block' | 'unblock',
  name: string,
  from: string | undefined,
): Promise<number> {
  if (from === undefined || from.trim() === '')
    throw new UsageError(`keith person ${sub} needs --from <other>`)
  const person = await findPerson(repos, name)
  const other = await findPerson(repos, from)
  if (other.id === person.id) throw refuse(`${person.name} can't ${sub} themselves.`)
  const current = (await repos.relationships.get(person.id)) ?? emptyCard(person.id)
  const has = current.blockedRelayFrom.includes(other.id)
  if (sub === 'block') {
    if (has) {
      run.out(`${person.name} already refuses relays from ${other.name}.`)
      return 0
    }
    await repos.relationships.upsert({
      ...current,
      blockedRelayFrom: [...current.blockedRelayFrom, other.id],
    })
    run.out(`${person.name} now refuses relays from ${other.name}.`)
    return 0
  }
  if (!has) {
    run.out(`${person.name} doesn't refuse relays from ${other.name}.`)
    return 0
  }
  await repos.relationships.upsert({
    ...current,
    blockedRelayFrom: current.blockedRelayFrom.filter((id) => id !== other.id),
  })
  run.out(`${person.name} accepts relays from ${other.name} again.`)
  return 0
}

const DELETED_LABELS: Record<keyof PersonRemoval['deleted'], string> = {
  directThreads: 'direct threads',
  directMessages: 'messages in direct threads',
  groupMessages: 'their messages in group threads',
  groupMemberships: 'group memberships',
  memories: 'memories',
  tasks: 'tasks',
  commitments: 'commitments',
  deliveries: 'deliveries',
  reminders: 'reminders',
  authTokens: 'sessions',
  inviteLinks: 'invite links',
  threadInvitations: 'group invitations',
  files: 'files',
}

const CLEARED_LABELS: Record<keyof PersonRemoval['cleared'], string> = {
  memories: 'memories they wrote about others',
  relays: 'relays they sent that were delivered',
  groupThreads: 'group threads they created',
  blockLists: 'block lists that named them',
}

async function remove(run: PersonRun, repos: PersonRepos, parsed: Parsed): Promise<number> {
  const person = await findPerson(repos, parsed.positionals[0] ?? '')
  if (person.tier === 'owner') throw refuse(`${person.name} is the owner; the owner can't be removed.`)
  const threads = await repos.threads.listForPerson(person.id)
  const direct = threads.filter((t) => t.kind === 'direct' && t.ownerPersonId === person.id).length
  const groups = threads.filter((t) => t.kind === 'group').length
  run.out(`This deletes ${person.name} (${person.tier}) and their data (ADR-0018):`)
  run.out(
    `  - their ${direct} direct thread(s), with every message, delivery, task, reminder and thread memory in them`,
  )
  run.out('  - every memory about them, their tasks, commitments, reminders, sessions and invite links')
  run.out(`  - their own messages in ${groups} group thread(s); they leave every group, Keith's replies stay`)
  run.out('  - the files they uploaded')
  run.out(
    'Memories they wrote about others, relays they delivered and groups they created stay, without them.',
  )
  run.out("There is no undo. Run 'keith backup' first to keep a way back.")

  if (parsed.values.yes !== true) {
    const prompter = run.prompter ?? terminalPrompter()
    try {
      const answer = (await prompter.ask(`Remove ${person.name}? (y/n)`, 'n')).trim().toLowerCase()
      if (answer !== 'y' && answer !== 'yes') {
        run.out('Cancelled. Nothing was removed.')
        return 1
      }
    } finally {
      if (run.prompter === undefined) prompter.close()
    }
  }

  const removal = await repos.persons.remove(person.id)
  run.out(`Removed ${person.name}.`)
  run.out('Deleted:')
  for (const [key, label] of Object.entries(DELETED_LABELS)) {
    run.out(`  ${label}: ${removal.deleted[key as keyof PersonRemoval['deleted']]}`)
  }
  run.out('Kept without them:')
  for (const [key, label] of Object.entries(CLEARED_LABELS)) {
    run.out(`  ${label}: ${removal.cleared[key as keyof PersonRemoval['cleared']]}`)
  }
  const deleted = await deleteFiles(run, removal.filePaths)
  if (removal.filePaths.length > 0) {
    run.out(`Deleted ${deleted} of ${removal.filePaths.length} stored file(s) from ${run.paths.filesDir}.`)
  }
  return 0
}

/** Deletes the stored bytes after the commit. A missing file (or one outside `files/`) is a warning. */
async function deleteFiles(run: PersonRun, filePaths: string[]): Promise<number> {
  const root = resolve(run.paths.filesDir)
  let deleted = 0
  for (const rel of filePaths) {
    const path = resolve(root, rel)
    if (!isInside(root, path) || path === root) {
      run.err(`warning: not deleting ${rel}: it is outside ${root}`)
      continue
    }
    try {
      await unlink(path)
      deleted++
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      run.err(
        code === 'ENOENT'
          ? `warning: file already missing: ${path}`
          : `warning: could not delete ${path}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return deleted
}

/**
 * Reads the config keys `keith person` needs. The `[plugins."<id>"]` sections are dropped first,
 * so an unset `env:` API key (`keith person` doesn't start the plugins) doesn't stop the command.
 */
export async function loadPersonConfig(
  paths: KeithPaths,
  env: Record<string, string | undefined>,
): Promise<PersonConfig> {
  const file = Bun.file(paths.configFile)
  if (!(await file.exists())) {
    throw new KeithError('CONFIG_INVALID', `config file not found: ${paths.configFile} (run 'keith setup')`)
  }
  const raw: unknown = Bun.TOML.parse(await file.text())
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const table = raw as Record<string, unknown>
    const plugins = table.plugins
    if (typeof plugins === 'object' && plugins !== null && !Array.isArray(plugins)) {
      const own = Object.fromEntries(
        Object.entries(plugins).filter(([, v]) => typeof v !== 'object' || v === null || Array.isArray(v)),
      )
      return parseConfig({ ...table, plugins: own }, { env })
    }
  }
  return parseConfig(raw, { env })
}

/** Runs `keith person <args>` on `KEITH_HOME`. Returns the process exit code. */
export async function runPersonCommand(args: string[], io: PersonCommandIo): Promise<number> {
  const home = io.env.KEITH_HOME
  // Same rule as `keithHome` in ./index.ts (not imported: index.ts imports this module).
  const paths = keithPaths(home !== undefined && home !== '' ? home : join(homedir(), '.keith'))
  return await runPerson(args, {
    paths,
    clock: io.clock ?? systemClock,
    out: io.out,
    err: io.err,
    prompter: io.prompter,
    config: () => loadPersonConfig(paths, io.env),
    open: async () => {
      if (!existsSync(paths.dbFile)) {
        throw new KeithError('INTERNAL', `no database at ${paths.dbFile} (run 'keith setup')`)
      }
      const db = openDb(paths.dbFile)
      return { repos: db.repos, close: () => db.close() }
    },
  })
}
