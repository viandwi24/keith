/**
 * Boot a core in a working copy, plant a private note of the owner, then open one guest session per case,
 * send the case's prompt and read the visitor-facing reply (docs/specs/evals.md, the guest scenario).
 */
import { createKeithClient, type KeithClient } from '@keith/client'
import { openDatabase } from '@keith/db'
import type { SessionFacts } from '@keith/host'
import type { AnyProviderDefinition } from 'eharness/providers'
import { createCore } from '../../src/compose.ts'
import type { Config } from '../../src/platform/config.ts'
import { silentLogger } from '../../src/platform/logger.ts'
import { migrateAll } from '../../src/testing/migrate-all.ts'
import { issueOwnerToken } from '../../src/testing/owner-token.ts'
import { type GuestCase, leakedMarkers, markersOf } from './cases.ts'

export interface GuestRunOptions {
  config: Config
  /** Extra provider definitions (the scripted guest model in `--scripted`). */
  definitions?: AnyProviderDefinition[]
  /** Connects the guest model to the core (scripted provider, or OpenRouter with a real model). */
  setup: (client: KeithClient, modelRef: string) => Promise<void>
  /** The `connection:model` reference of the guest role. */
  modelRef: string
  /** Offline catalogs: the scripted mode never downloads prices. */
  offline: boolean
  cases: readonly GuestCase[]
  /** Abort the remaining cases when the run spent more than this (USD). */
  maxUsd?: number
  /** How long one case may take (ms). */
  timeoutMs?: number
}

export interface CaseResult {
  id: string
  kind: GuestCase['kind']
  prompt: string
  /** The visitor-facing text of the reply. */
  reply: string
  /** Markers the reply carried (labels). Empty when the case passes. */
  leaked: string[]
  stop: string
}

export interface GuestRun {
  cases: CaseResult[]
  costUsd: number
  aborted: 'max-usd' | undefined
  /** True when every planned case ran (an abort or an error leaves some out). */
  complete: boolean
}

/** The visitor's address hash: each case uses its own, so the start window of one never blocks another. */
const addressOf = (index: number): string => `eval-${index.toString().padStart(4, '0')}`

export async function runGuestCases(options: GuestRunOptions): Promise<GuestRun> {
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
    const client = createKeithClient({ baseUrl: server.url.href, token })
    await options.setup(client, options.modelRef)
    await client.rpc.admin.guests.set({ enabled: true })
    const privateBody = `private note ${crypto.randomUUID().slice(0, 12)}`
    await plantPrivateNote(core, privateBody)
    return await drive(client, core, options, privateBody)
  } finally {
    await server.stop(true)
    await core.close()
  }
}

/** The owner's private note: no guest may see it, so a reply that carries it is a leak. */
async function plantPrivateNote(
  core: Awaited<ReturnType<typeof createCore>>,
  body: string,
): Promise<void> {
  const op = core.plugins
    .loaded()
    .find((p) => p.id === 'notes')
    ?.operation('create')
  if (op === undefined) throw new Error('the notes plugin is not loaded: no private note to plant')
  const facts: SessionFacts = { id: 'front:owner', kind: 'front', method: 'token', elevated: true }
  await core.plugins.guard.run(
    op,
    { title: 'owner diary', body },
    { principal: { id: 'owner' }, session: facts },
  )
}

async function drive(
  client: KeithClient,
  core: Awaited<ReturnType<typeof createCore>>,
  options: GuestRunOptions,
  privateBody: string,
): Promise<GuestRun> {
  const spentBefore = (await client.rpc.budget.get()).spentUsd
  const cost = async (): Promise<number> => (await client.rpc.budget.get()).spentUsd - spentBefore
  const markers = markersOf({ modelRef: options.modelRef, privateBody })
  const results: CaseResult[] = []
  let aborted: GuestRun['aborted']
  for (const [index, item] of options.cases.entries()) {
    if (options.maxUsd !== undefined && (await cost()) > options.maxUsd) {
      aborted = 'max-usd'
      break
    }
    const opened = await core.guests.open({ zone: 'lan', ipHash: addressOf(index) })
    if (!opened.ok) throw new Error(`a guest session was refused: ${opened.block}`)
    const session = opened.session
    try {
      const turn = await session.session().send(item.prompt).result
      const reply = await visitorText(session.session())
      results.push({
        id: item.id,
        kind: item.kind,
        prompt: item.prompt,
        reply,
        leaked: leakedMarkers(reply, markers),
        stop: turn.stop,
      })
    } finally {
      await core.guests.end(session.id, 'closed')
    }
  }
  return {
    cases: results,
    costUsd: await cost(),
    aborted,
    complete: aborted === undefined && results.length === options.cases.length,
  }
}

/** The assistant text of a guest session, in order (what the visitor sees). */
async function visitorText(session: {
  messages(): Promise<{ role: string; parts?: unknown[] }[]>
}): Promise<string> {
  const messages = await session.messages()
  return messages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => m.parts ?? [])
    .map((p) => {
      const part = p as { type?: string; text?: string }
      return part.type === 'text' ? (part.text ?? '') : ''
    })
    .join('\n')
    .trim()
}
