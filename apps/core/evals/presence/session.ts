/**
 * Boot a core in a working copy, add the members, plant a note on the owner's and on Ben's status, then for each case set
 * the subject's level for members, ask the front agent as `ana` and read what `ana` got: the text of the reply and of the
 * tool outputs of the new messages (docs/specs/evals.md, the presence scenario).
 */
import { createKeithClient, type KeithClient } from '@keith/client'
import { openDatabase } from '@keith/db'
import type { AnyProviderDefinition } from 'eharness/providers'
import { createCore } from '../../src/compose.ts'
import type { Config } from '../../src/platform/config.ts'
import { silentLogger } from '../../src/platform/logger.ts'
import { migrateAll } from '../../src/testing/migrate-all.ts'
import { issueOwnerToken } from '../../src/testing/owner-token.ts'
import { leaksOf, noteAppears, type PresenceCase, SUBJECTS, type Subject, VIEWER } from './cases.ts'

export interface PresenceRunOptions {
  config: Config
  /** Extra provider definitions (the scripted front model in `--scripted`). */
  definitions?: AnyProviderDefinition[]
  /** Connects the front model to the core (scripted provider, or OpenRouter with a real model). */
  setup: (client: KeithClient, modelRef: string) => Promise<void>
  /** The `connection:model` reference of the front role. */
  modelRef: string
  /** Offline catalogs: the scripted mode never downloads prices. */
  offline: boolean
  cases: readonly PresenceCase[]
  /** The notes of the run, written before the first case (the scripted steps read them when they run). */
  notes: Record<Subject, string>
  /** Abort the remaining cases when the run spent more than this (USD). */
  maxUsd?: number
}

export interface PresenceCaseResult {
  id: string
  kind: PresenceCase['kind']
  level: PresenceCase['level']
  subject: Subject
  prompt: string
  /** The text the viewer's turn showed the model and the viewer: reply text and tool outputs. */
  visible: string
  /** True when the subject's note reached the viewer (expected only at `detail`). */
  released: boolean
  /** Notes that reached the viewer above the subject's level. Empty when the case passes. */
  leaked: string[]
}

export interface PresenceRun {
  cases: PresenceCaseResult[]
  costUsd: number
  aborted: 'max-usd' | undefined
  /** True when every planned case ran (an abort or an error leaves some out). */
  complete: boolean
}

export async function runPresenceCases(options: PresenceRunOptions): Promise<PresenceRun> {
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

    const ids: Partial<Record<string, string>> = {}
    const clients: Partial<Record<string, KeithClient>> = {}
    for (const username of [VIEWER, 'ben']) {
      const person = await owner.rpc.admin.people.add({ username })
      ids[username] = person.id
      const memberToken = await issueOwnerToken(config, username, { personId: person.id })
      clients[username] = createKeithClient({ baseUrl: server.url.href, token: memberToken })
    }
    clients.owner = owner
    await plantNotes(clients, options.notes)
    return await drive(clients, ids, options)
  } finally {
    await server.stop(true)
    await core.close()
  }
}

/** The owner and Ben are busy, each with a note only they may show (verbatim or released at `detail`). */
async function plantNotes(
  clients: Partial<Record<string, KeithClient>>,
  notes: Record<Subject, string>,
): Promise<void> {
  for (const subject of SUBJECTS) {
    await clients[subject]?.rpc.presence.setStatus({
      busy: true,
      note: notes[subject],
      minutes: 60,
    })
  }
}

async function drive(
  clients: Partial<Record<string, KeithClient>>,
  ids: Partial<Record<string, string>>,
  options: PresenceRunOptions,
): Promise<PresenceRun> {
  const viewer = clients[VIEWER]
  const viewerId = ids[VIEWER]
  if (viewer === undefined || viewerId === undefined) throw new Error('the viewer was not added')
  const session = `front:${viewerId}`
  const owner = clients.owner
  if (owner === undefined) throw new Error('the owner client is missing')
  const spentBefore = (await owner.rpc.budget.get()).spentUsd
  const cost = async (): Promise<number> => (await owner.rpc.budget.get()).spentUsd - spentBefore
  const results: PresenceCaseResult[] = []
  const seen = new Set<string>()
  let aborted: PresenceRun['aborted']
  for (const item of options.cases) {
    if (options.maxUsd !== undefined && (await cost()) > options.maxUsd) {
      aborted = 'max-usd'
      break
    }
    // the subject's own setting for members: the level the case plans
    await clients[item.subject]?.rpc.presence.disclosure.set({
      audience: '@users',
      level: item.level,
    })
    for await (const _ of viewer.reply(item.prompt, session)) {
      // drain: the stream ends with the turn
    }
    const messages = (await viewer.harness.sessions.messages(session, { limit: 200 })).messages
    const fresh = messages.filter((m) => !seen.has(m.id))
    for (const m of fresh) seen.add(m.id)
    const visible = visibleOf(fresh)
    const note = options.notes[item.subject]
    results.push({
      id: item.id,
      kind: item.kind,
      level: item.level,
      subject: item.subject,
      prompt: item.prompt,
      visible,
      released: item.level === 'detail' && noteAppears(visible, note),
      leaked: leaksOf(item, visible, options.notes),
    })
  }
  return {
    cases: results,
    costUsd: await cost(),
    aborted,
    complete: aborted === undefined && results.length === options.cases.length,
  }
}

/** The text the model and the viewer saw in these messages: text parts and the outputs of tool parts. */
export function visibleOf(messages: { parts?: unknown[] }[]): string {
  return messages
    .flatMap((m) => m.parts ?? [])
    .map((p) => {
      const part = p as { type?: string; text?: string; output?: unknown }
      if (part.type === 'text') return part.text ?? ''
      if (part.type?.startsWith('tool-') === true) return JSON.stringify(part.output ?? null)
      return ''
    })
    .join('\n')
    .trim()
}
