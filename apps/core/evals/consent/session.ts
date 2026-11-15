/**
 * Boot a core in a working copy and run the cases in the owner's front session: plant the text (a note of the owner, or the report
 * of a worker the model delegates to), send the prompt, wait until the turn and its tasks settle, read what is waiting and what ran,
 * then deny whatever waits so the next case starts clean (docs/specs/evals.md, the consent scenario).
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
import { until } from '../../src/testing/wait.ts'
import {
  type ConsentCase,
  type Observation,
  type PendingItem,
  RISKY_TOOLS,
  violationsOf,
} from './cases.ts'

export interface ConsentRunOptions {
  config: Config
  /** Extra provider definitions (the scripted models in `--scripted`). */
  definitions?: AnyProviderDefinition[]
  /** Connects the front and worker models to the core (scripted providers, or OpenRouter with a real model). */
  setup: (client: KeithClient, modelRef: string) => Promise<void>
  modelRef: string
  /** Offline catalogs: the scripted mode never downloads prices. */
  offline: boolean
  cases: readonly ConsentCase[]
  /** Abort the remaining cases when the run spent more than this (USD). */
  maxUsd?: number
  /** How long one case may take to settle (ms). */
  turnMs?: number
}

export interface ConsentCaseResult {
  id: string
  channel: ConsentCase['channel']
  prompt: string
  /** Requests that waited after the turn (nobody answered them). */
  pending: PendingItem[]
  /** Risky tools that ran. */
  ran: string[]
  /** Rules broken by this case. Empty when the case passes. */
  violations: string[]
}

export interface ConsentRun {
  cases: ConsentCaseResult[]
  costUsd: number
  aborted: 'max-usd' | undefined
  /** True when every planned case ran and settled. */
  complete: boolean
}

const SESSION = 'front:owner'

export async function runConsentCases(options: ConsentRunOptions): Promise<ConsentRun> {
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
    const attention = attentionOf(server.url, token)
    const plant = notePlanter(core)
    return await drive(owner, attention, plant, options)
  } finally {
    await server.stop(true)
    await core.close()
  }
}

type Attention = {
  list(): Promise<Array<PendingItem & { id: string; sessionId: string }>>
  deny(item: { id: string; sessionId: string }): Promise<void>
}

/** The HTTP attention list and answer route, as every client uses them (the tier is `extra.consent`). */
function attentionOf(base: URL, token: string): Attention {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  return {
    async list() {
      const response = await fetch(new URL('/attention', base), { headers })
      if (!response.ok) throw new Error(`GET /attention: ${response.status}`)
      const body = (await response.json()) as {
        items: Array<{
          id: string
          sessionId: string
          toolName?: string
          extra?: Record<string, unknown>
        }>
      }
      return body.items.map((i) => ({
        id: i.id,
        sessionId: i.sessionId,
        toolName: i.toolName ?? '',
        consent: typeof i.extra?.consent === 'string' ? i.extra.consent : undefined,
      }))
    },
    async deny(item) {
      const response = await fetch(new URL(`/attention/${item.id}/answer`, base), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          sessionId: item.sessionId,
          answer: { kind: 'approval', approved: false, reason: 'eval: nobody answers' },
        }),
      })
      if (!response.ok) throw new Error(`answer: ${response.status}`)
    },
  }
}

/** The owner's note: outside text for the front agent, exactly as a note written by anyone else would be. */
function notePlanter(core: Awaited<ReturnType<typeof createCore>>) {
  return async (title: string, body: string): Promise<void> => {
    const op = core.plugins
      .loaded()
      .find((p) => p.id === 'notes')
      ?.operation('create')
    if (op === undefined) throw new Error('the notes plugin is not loaded: no note to plant')
    const facts: SessionFacts = { id: SESSION, kind: 'front', method: 'token', elevated: true }
    await core.plugins.guard.run(
      op,
      { title, body },
      { principal: { id: 'owner' }, session: facts },
    )
  }
}

interface Part {
  type?: string
  state?: string
  toolName?: string
  toolCallId?: string
}

async function drive(
  owner: KeithClient,
  attention: Attention,
  plant: (title: string, body: string) => Promise<void>,
  options: ConsentRunOptions,
): Promise<ConsentRun> {
  const spentBefore = (await owner.rpc.budget.get()).spentUsd
  const cost = async (): Promise<number> => (await owner.rpc.budget.get()).spentUsd - spentBefore
  const turnMs = options.turnMs ?? 90_000
  const ranOf = async (): Promise<Map<string, string>> => {
    const { messages } = await owner.harness.sessions.messages(SESSION, { limit: 200 })
    const ran = new Map<string, string>()
    for (const m of messages) {
      for (const p of (m.parts ?? []) as Part[]) {
        const name = p.toolName ?? (p.type?.startsWith('tool-') ? p.type.slice(5) : undefined)
        if (name !== undefined && RISKY_TOOLS.includes(name) && p.state === 'output-available')
          ran.set(p.toolCallId ?? `${name}-${ran.size}`, name)
      }
    }
    return ran
  }
  const settle = async (): Promise<void> => {
    // idle: the front turn is over and no task runs, on two reads in a row (a wake turn may start right after a task ends)
    let calm = 0
    await until(
      'the turn and its tasks settle',
      async () => {
        const [session, tasks] = await Promise.all([
          owner.harness.sessions.get(SESSION),
          owner.rpc.tasks.list({}),
        ])
        const busy =
          session.running || tasks.some((t) => t.status === 'running' || t.status === 'queued')
        calm = busy ? 0 : calm + 1
        return calm
      },
      (n) => n >= 3,
      turnMs,
    )
  }
  const results: ConsentCaseResult[] = []
  let aborted: ConsentRun['aborted']
  for (const item of options.cases) {
    if (options.maxUsd !== undefined && (await cost()) > options.maxUsd) {
      aborted = 'max-usd'
      break
    }
    await plant(`eval ${item.id}`, item.planted)
    const ranBefore = await ranOf()
    const templateBefore = (await owner.rpc.persona.get({})).templateId
    const addressBefore = (await owner.rpc.persona.style.get({})).address ?? undefined
    for await (const _ of owner.reply(item.prompt, SESSION)) {
      // drain: the stream ends with the turn
    }
    try {
      await settle()
    } catch {
      break
    }
    const waiting = await attention.list()
    const ran = [...(await ranOf())].filter(([id]) => !ranBefore.has(id)).map(([, name]) => name)
    const observation: Observation = {
      items: waiting.map((w) => ({ toolName: w.toolName, consent: w.consent })),
      ran,
      templateBefore,
      templateAfter: (await owner.rpc.persona.get({})).templateId,
      addressBefore,
      addressAfter: (await owner.rpc.persona.style.get({})).address ?? undefined,
    }
    results.push({
      id: item.id,
      channel: item.channel,
      prompt: item.prompt,
      pending: observation.items,
      ran,
      violations: violationsOf(observation),
    })
    // nobody approves: deny what waits, let the model finish, and start the next case from a clean session
    for (const w of waiting) await attention.deny(w)
    await settle().catch(() => undefined)
  }
  return {
    cases: results,
    costUsd: await cost(),
    aborted,
    complete: aborted === undefined && results.length === options.cases.length,
  }
}
