/**
 * Boot a core in a working copy, add the member, then for each case send the message as the member and read what the
 * member's agenda gained (docs/specs/evals.md, the agenda scenario). The items are read through the member's own
 * `agenda.list` RPC, so only the member's items are scored.
 */
import { createKeithClient, type KeithClient } from '@keith/client'
import { openDatabase } from '@keith/db'
import type { AnyProviderDefinition } from 'eharness/providers'
import { createCore } from '../../src/compose.ts'
import type { Config } from '../../src/platform/config.ts'
import { silentLogger } from '../../src/platform/logger.ts'
import { migrateAll } from '../../src/testing/migrate-all.ts'
import { issueOwnerToken } from '../../src/testing/owner-token.ts'
import { type AgendaCase, type CaseScore, type StoredItem, scoreCase, VIEWER } from './cases.ts'

export interface AgendaRunOptions {
  config: Config
  /** Extra provider definitions (the scripted front model in `--scripted`). */
  definitions?: AnyProviderDefinition[]
  /** Connects the front model to the core (scripted provider, or OpenRouter with a real model). */
  setup: (client: KeithClient, modelRef: string) => Promise<void>
  /** The `connection:model` reference of the front role. */
  modelRef: string
  /** Offline catalogs: the scripted mode never downloads prices. */
  offline: boolean
  cases: readonly AgendaCase[]
  /** Abort the remaining cases when the run spent more than this (USD). */
  maxUsd?: number
}

export interface AgendaCaseResult extends CaseScore {
  id: string
  kind: AgendaCase['kind']
  prompt: string
  /** The items this message stored, times as ISO 8601 (`endsAt` null when the item has none). */
  stored: { what: string; startsAt: string; endsAt: string | null; status: string }[]
}

export interface AgendaRun {
  cases: AgendaCaseResult[]
  costUsd: number
  aborted: 'max-usd' | undefined
  /** True when every planned case ran (an abort or an error leaves some out). */
  complete: boolean
}

/** A window that holds every item a case can store (epoch ms: 1970 to 2100). */
const WINDOW = { from: 0, to: 4_102_444_800_000 }

export async function runAgendaCases(options: AgendaRunOptions): Promise<AgendaRun> {
  const { config } = options
  const sqlite = openDatabase(config.dbFile)
  migrateAll(sqlite)
  sqlite.close()
  const core = await createCore({
    config,
    logger: silentLogger,
    ...(options.offline ? { catalogs: { offline: true } } : {}),
    definitions: options.definitions ?? [],
    timing: { inboxPollMs: 50, reconcileEveryMs: 3_600_000, pruneEveryMs: 3_600_000 },
  })
  const server = Bun.serve({ port: 0, fetch: core.fetch, websocket: core.websocket })
  try {
    const token = await issueOwnerToken(config)
    const owner = createKeithClient({ baseUrl: server.url.href, token })
    await options.setup(owner, options.modelRef)
    const person = await owner.rpc.admin.people.add({ username: VIEWER })
    const memberToken = await issueOwnerToken(config, VIEWER, { personId: person.id })
    const viewer = createKeithClient({ baseUrl: server.url.href, token: memberToken })
    return await drive(owner, viewer, person.id, options)
  } finally {
    await server.stop(true)
    await core.close()
  }
}

async function drive(
  owner: KeithClient,
  viewer: KeithClient,
  viewerId: string,
  options: AgendaRunOptions,
): Promise<AgendaRun> {
  const session = `front:${viewerId}`
  const spentBefore = (await owner.rpc.budget.get()).spentUsd
  const cost = async (): Promise<number> => (await owner.rpc.budget.get()).spentUsd - spentBefore
  const results: AgendaCaseResult[] = []
  const seen = new Set<string>()
  let aborted: AgendaRun['aborted']
  for (const item of options.cases) {
    if (options.maxUsd !== undefined && (await cost()) > options.maxUsd) {
      aborted = 'max-usd'
      break
    }
    for await (const _ of viewer.reply(item.prompt, session)) {
      // drain: the stream ends with the turn
    }
    const fresh = (await viewer.rpc.agenda.list(WINDOW)).items.filter((row) => !seen.has(row.id))
    for (const row of fresh) seen.add(row.id)
    const stored: StoredItem[] = fresh.map((row) => ({
      what: row.what,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      status: row.status,
    }))
    results.push({
      id: item.id,
      kind: item.kind,
      prompt: item.prompt,
      stored: fresh.map((row) => ({
        what: row.what,
        startsAt: new Date(row.startsAt).toISOString(),
        endsAt: row.endsAt === null ? null : new Date(row.endsAt).toISOString(),
        status: row.status,
      })),
      ...scoreCase(item, stored),
    })
  }
  return {
    cases: results,
    costUsd: await cost(),
    aborted,
    complete: aborted === undefined && results.length === options.cases.length,
  }
}
