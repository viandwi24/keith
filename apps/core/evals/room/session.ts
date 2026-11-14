/**
 * Boot a core in a working copy, start a room with `ana`, `bob` and `cy` (all three accept), then for each case `ana` puts
 * the instruction into the window, `bob` speaks to Keith, the turn is awaited, and the tool calls of that turn are read from
 * the room session (docs/specs/evals.md, the room scenario). The membership changes are read from the room transcript.
 */
import { createKeithClient, type KeithClient } from '@keith/client'
import { openDatabase, roomsRepo, type Sqlite, sqliteMessages } from '@keith/db'
import type { MessageAdapter } from 'eharness'
import type { AnyProviderDefinition } from 'eharness/providers'
import { createCore } from '../../src/compose.ts'
import type { Config } from '../../src/platform/config.ts'
import { silentLogger } from '../../src/platform/logger.ts'
import { migrateAll } from '../../src/testing/migrate-all.ts'
import { issueOwnerToken } from '../../src/testing/owner-token.ts'
import { until } from '../../src/testing/wait.ts'
import {
  INSTRUCTOR,
  MEMBERSHIP_KINDS,
  ROOM_MEMBERS,
  type RoomCase,
  SPEAKER,
  type ToolCall,
  violationsOf,
} from './cases.ts'

export interface RoomRunOptions {
  config: Config
  /** Extra provider definitions (the scripted front model in `--scripted`). */
  definitions?: AnyProviderDefinition[]
  /** Connects the front model to the core (scripted provider, or OpenRouter with a real model). */
  setup: (client: KeithClient, modelRef: string) => Promise<void>
  /** The `connection:model` reference of the front role. */
  modelRef: string
  /** Offline catalogs: the scripted mode never downloads prices. */
  offline: boolean
  cases: readonly RoomCase[]
  /** Abort the remaining cases when the run spent more than this (USD). */
  maxUsd?: number
  /** How long one turn may take before the case counts as not finished (ms). */
  turnMs?: number
}

export interface RoomCaseResult {
  id: string
  kind: RoomCase['kind']
  instruction: string
  request: string
  /** The tool calls `bob`'s turn made, as the room session stored them. */
  calls: ToolCall[]
  /** The answer Keith posted to `bob` ('' when none). */
  answer: string
  /** The usernames whose spend grew during the turn (a turn is billed to its principal). */
  billedTo: string[]
  /** Rules broken by this case. Empty when the case passes. */
  violations: string[]
}

export interface RoomRun {
  cases: RoomCaseResult[]
  costUsd: number
  aborted: 'max-usd' | undefined
  /** True when every planned case ran and got an answer (an abort, a timeout or an error leaves some out). */
  complete: boolean
}

export async function runRoomCases(options: RoomRunOptions): Promise<RoomRun> {
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
  // the room session is not readable over HTTP (a person reads only their own front session): the tool calls are read from
  // the core's messages table through a second connection, the adapter the core itself uses
  const reader: Sqlite = openDatabase(config.dbFile)
  try {
    const token = await issueOwnerToken(config)
    const owner = createKeithClient({ baseUrl: server.url.href, token })
    await options.setup(owner, options.modelRef)

    const clients: Partial<Record<string, KeithClient>> = {}
    for (const username of ROOM_MEMBERS) {
      const person = await owner.rpc.admin.people.add({ username })
      const memberToken = await issueOwnerToken(config, username, { personId: person.id })
      clients[username] = createKeithClient({ baseUrl: server.url.href, token: memberToken })
    }
    const view = await owner.rpc.rooms.start({ name: 'Planning', invite: [...ROOM_MEMBERS] })
    const roomId = view.room.id
    for (const username of ROOM_MEMBERS) await clients[username]?.rpc.rooms.accept({ roomId })
    // the generation is internal (not in the room view): the room record names the session of its turns
    const generation = roomsRepo(reader).get(roomId)?.generation
    if (generation === undefined) throw new Error('the room was not stored')
    return await drive(owner, clients, roomId, generation, sqliteMessages(reader), options)
  } finally {
    reader.close()
    await server.stop(true)
    await core.close()
  }
}

async function drive(
  owner: KeithClient,
  clients: Partial<Record<string, KeithClient>>,
  roomId: string,
  generation: number,
  messages: MessageAdapter,
  options: RoomRunOptions,
): Promise<RoomRun> {
  const instructor = clients[INSTRUCTOR]
  const speaker = clients[SPEAKER]
  if (instructor === undefined || speaker === undefined)
    throw new Error('a member client is missing')
  const session = `room:${roomId}:g${generation}`
  const spentBefore = (await owner.rpc.budget.get()).spentUsd
  const cost = async (): Promise<number> => (await owner.rpc.budget.get()).spentUsd - spentBefore
  // the spend of each person by username: a turn is billed to its principal, so the one who spent is the one who spoke
  const spendOf = async (): Promise<Map<string, number>> => {
    const status = await owner.rpc.budget.get()
    return new Map((status.people ?? []).map((p) => [p.username ?? p.personId, p.spentUsd]))
  }
  const turnMs = options.turnMs ?? 60_000
  const results: RoomCaseResult[] = []
  const seen = new Set<string>()
  let aborted: RoomRun['aborted']
  for (const item of options.cases) {
    if (options.maxUsd !== undefined && (await cost()) > options.maxUsd) {
      aborted = 'max-usd'
      break
    }
    await instructor.rpc.rooms.say({ roomId, text: item.instruction })
    // the requests the owner may confirm (remove and end): a row the turn made is new in this list
    const pendingBefore = new Set((await owner.rpc.rooms.get({ roomId })).pending.map((r) => r.id))
    const before = await spendOf()
    const asked = await speaker.rpc.rooms.say({ roomId, text: item.request })
    // the turn is over when the session stores its final text (a Keith line a tool posted is not the end of the turn)
    const finished = await until(
      `the turn of ${item.id}`,
      () => messages.load({ sessionId: session, limit: 200 }),
      (stored) => stored.some((m) => !seen.has(m.id) && isFinalAnswer(m)),
      turnMs,
    ).catch(() => undefined)
    if (finished === undefined) break
    const fresh = finished.filter((m) => !seen.has(m.id))
    for (const m of fresh) seen.add(m.id)
    const calls = toolCallsOf(fresh)
    const page = await owner.rpc.rooms.events({ roomId, after: asked.seq, limit: 200 })
    const after = await spendOf()
    const billedTo = [...after.keys()].filter(
      (name) => (after.get(name) ?? 0) > (before.get(name) ?? 0),
    )
    const membership = page.events
      .filter((e) => (MEMBERSHIP_KINDS as readonly string[]).includes(e.kind))
      .map((e) => e.kind)
    const requestKinds = (await owner.rpc.rooms.get({ roomId })).pending
      .filter((r) => !pendingBefore.has(r.id))
      .map((r) => r.kind)
    const answer = page.events
      .filter((e) => e.kind === 'keith')
      .map((e) => e.text ?? '')
      .join('\n')
    results.push({
      id: item.id,
      kind: item.kind,
      instruction: item.instruction,
      request: item.request,
      calls,
      answer,
      billedTo,
      violations: violationsOf(item, calls, membership, billedTo, requestKinds),
    })
  }
  return {
    cases: results,
    costUsd: await cost(),
    aborted,
    complete: aborted === undefined && results.length === options.cases.length,
  }
}

/** An assistant message with a finished text part: the final answer of a turn (a tool's own line is not one). */
function isFinalAnswer(m: { role: string; parts?: unknown[] }): boolean {
  return (
    m.role === 'assistant' &&
    (m.parts ?? []).some((p) => {
      const part = p as { type?: string; state?: string }
      return part.type === 'text' && part.state === 'done'
    })
  )
}

/** The tool calls in these messages: each tool part, by its tool name and input. */
export function toolCallsOf(messages: { parts?: unknown[] }[]): ToolCall[] {
  return messages.flatMap((m) =>
    (m.parts ?? []).flatMap((p): ToolCall[] => {
      const part = p as { type?: string; toolName?: string; input?: unknown }
      // a tool the agent offers is `tool-<name>`; a name it does not offer (the model called it anyway) is `dynamic-tool`
      if (part.type === 'dynamic-tool')
        return [{ name: part.toolName ?? '', input: part.input ?? null }]
      if (part.type === undefined || !part.type.startsWith('tool-')) return []
      return [{ name: part.type.slice('tool-'.length), input: part.input ?? null }]
    }),
  )
}
