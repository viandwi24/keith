/** Boot a core in process, send the news prompt, wait for the proactive answer, collect the facts. */
import { createKeithClient, type KeithClient } from '@keith/client'
import type { Task } from '@keith/contracts'
import { openDatabase } from '@keith/db'
import type { UIMessage } from 'ai'
import type { AnyProviderDefinition } from 'eharness/providers'
import { type NewsChecks, runChecks, transcriptOf } from '../../evals/news/checks.ts'
import { createCore } from '../compose.ts'
import type { Config } from '../platform/config.ts'
import { silentLogger } from '../platform/logger.ts'
import { migrateAll } from './migrate-all.ts'
import { issueOwnerToken } from './owner-token.ts'
import { until } from './wait.ts'

export const NEWS_PROMPT = 'show me the news today please'

export interface NewsRunOptions {
  config: Config
  /** Extra provider definitions (the scripted providers in `--scripted`). */
  definitions?: AnyProviderDefinition[]
  /** Runs once after boot, before the prompt (connect the scripted providers). */
  setup?: (client: KeithClient) => Promise<void>
  /** Offline catalogs: the scripted mode never downloads prices. */
  offline?: boolean
  prompt?: string
  /** How long to wait for the proactive answer. */
  timeoutMs?: number
  pollMs?: number
  /** Abort the run when it spent more than this (USD). */
  maxUsd?: number
}

export interface NewsRun {
  prompt: string
  messages: UIMessage[]
  tasks: Task[]
  checks: NewsChecks
  costUsd: number
  /** Time until the front's first reply ended (the acknowledgement). */
  ackMs: number
  totalMs: number
  timedOut: boolean
  aborted: 'max-usd' | undefined
}

const TERMINAL = new Set(['done', 'failed', 'stopped', 'timed_out', 'interrupted'])

export async function runNews(options: NewsRunOptions): Promise<NewsRun> {
  const { config } = options
  const prompt = options.prompt ?? NEWS_PROMPT
  const sqlite = openDatabase(config.dbFile)
  migrateAll(sqlite)
  sqlite.close()
  const core = await createCore({
    config,
    logger: silentLogger,
    ...(options.offline === true ? { catalogs: { offline: true } } : {}),
    definitions: options.definitions ?? [],
    timing: { inboxPollMs: 50, reconcileEveryMs: 3_600_000, pruneEveryMs: 3_600_000 },
  })
  const server = Bun.serve({ port: 0, fetch: core.fetch, websocket: core.websocket })
  try {
    // boot issues no token: mint one in the working copy, never in the original
    const token = await issueOwnerToken(config)
    const client = createKeithClient({ baseUrl: server.url.href, token })
    await options.setup?.(client)
    return await drive(client, prompt, options)
  } finally {
    await server.stop(true)
    await core.close()
  }
}

async function drive(client: KeithClient, prompt: string, o: NewsRunOptions): Promise<NewsRun> {
  const timeoutMs = o.timeoutMs ?? 300_000
  const spentBefore = (await client.rpc.budget.get()).spentUsd
  const cost = async (): Promise<number> => (await client.rpc.budget.get()).spentUsd - spentBefore
  const messagesOf = async (): Promise<UIMessage[]> =>
    (await client.harness.sessions.messages('front:owner', { limit: 200 })).messages
  const started = Date.now()
  for await (const _ of client.reply(prompt)) {
    // drain: the stream ends with the turn
  }
  const ackMs = Date.now() - started
  let aborted: NewsRun['aborted']
  let timedOut = false
  const finished = async (): Promise<boolean> => {
    if (o.maxUsd !== undefined && (await cost()) > o.maxUsd) {
      aborted = 'max-usd'
      return true
    }
    const [tasks, session, messages] = await Promise.all([
      client.rpc.tasks.list({}),
      client.harness.sessions.get('front:owner'),
      messagesOf(),
    ])
    if (session.running) return false
    const events = transcriptOf(messages)
    const report = events.findIndex((e) => e.kind === 'report')
    if (tasks.length === 0) return Date.now() - started > ackMs + 3_000 // never delegated
    if (!tasks.every((t) => TERMINAL.has(t.status))) return false
    return events.slice(report + 1).some((e) => e.kind === 'assistant') && report >= 0
  }
  await until('the proactive answer', finished, Boolean, timeoutMs).catch(() => {
    timedOut = true
  })
  const [messages, tasks] = await Promise.all([messagesOf(), client.rpc.tasks.list({})])
  const task = tasks.at(-1)
  const checks = runChecks({
    messages,
    taskStatus: task?.status,
    taskSummary: task?.summary ?? task?.error ?? undefined,
  })
  return {
    prompt,
    messages,
    tasks,
    checks,
    costUsd: await cost(),
    ackMs,
    totalMs: Date.now() - started,
    timedOut,
    aborted,
  }
}
