/**
 * Boot a core in a working copy, add the member `mara`, plant her memory note, then run the cases in order: each case does its
 * setup (the owner's template switch, `mara`'s style, her speech client), sends the prompt as `mara` and reads the stored answer
 * and the model calls of the turn (docs/specs/evals.md, the persona scenario).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createKeithClient, type KeithClient } from '@keith/client'
import { openDatabase, type Sqlite, sqliteMessages } from '@keith/db'
import type { MessageAdapter } from 'eharness'
import type { AnyProviderDefinition } from 'eharness/providers'
import { createCore } from '../../src/compose.ts'
import { memoryDir } from '../../src/modules/hippocampus/hippocampus.ts'
import { renderPersonaBlock } from '../../src/modules/prefrontal/prompt.ts'
import type { Config } from '../../src/platform/config.ts'
import { silentLogger } from '../../src/platform/logger.ts'
import { migrateAll } from '../../src/testing/migrate-all.ts'
import { issueOwnerToken } from '../../src/testing/owner-token.ts'
import { until } from '../../src/testing/wait.ts'
import {
  type CheckResult,
  escapedJson,
  MEMORY_NOTE,
  PERSONA_CASES,
  type PersonaCase,
  RULE_STYLE,
  scoreTurn,
  styleNeverInPrompt,
  type TurnObservation,
  VIEWER,
} from './cases.ts'

export interface PersonaRunOptions {
  config: Config
  /** Extra provider definitions (the scripted front model in `--scripted`). */
  definitions?: AnyProviderDefinition[]
  /** Connects the front model to the core (scripted provider, or OpenRouter with a real model). */
  setup: (client: KeithClient, modelRef: string) => Promise<void>
  /** The `connection:model` reference of the front role. */
  modelRef: string
  /** Offline catalogs: the scripted mode never downloads prices. */
  offline: boolean
  /** Abort the remaining cases when the run spent more than this (USD). */
  maxUsd?: number
  /** How long one turn may take before the case counts as not finished (ms). */
  turnMs?: number
  /**
   * The model calls so far, each as JSON text: the scripted model's prompts, or the request bodies sent to the provider in real
   * mode (the cli records them). A turn's calls are the ones added during it.
   */
  capture: () => string[]
}

export interface PersonaCaseResult {
  id: PersonaCase['id']
  prompt: string
  /** The assistant text stored for the turn ('' when none). */
  answer: string
  /** Number of model calls the turn made. */
  calls: number
  checks: CheckResult[]
}

export interface PersonaRun {
  cases: PersonaCaseResult[]
  /** Checks over the whole run (the refused style value reached no model call). */
  runChecks: CheckResult[]
  costUsd: number
  aborted: 'max-usd' | undefined
  /** True when every planned case ran and got an answer (an abort, a timeout or an error leaves some out). */
  complete: boolean
}

export async function runPersonaCases(options: PersonaRunOptions): Promise<PersonaRun> {
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
  // the stored answer is read through a second connection, the adapter the core itself uses
  const reader: Sqlite = openDatabase(config.dbFile)
  try {
    const token = await issueOwnerToken(config)
    const owner = createKeithClient({ baseUrl: server.url.href, token })
    await options.setup(owner, options.modelRef)
    const person = await owner.rpc.admin.people.add({ username: VIEWER })
    // the profile is always in the member's model context: the note is written before her first turn
    const dir = memoryDir(config.dataDir, person.id)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, 'profile.md'), `${MEMORY_NOTE}\n`, { mode: 0o600 })
    const memberToken = await issueOwnerToken(config, VIEWER, { personId: person.id })
    const viewer = createKeithClient({ baseUrl: server.url.href, token: memberToken })
    return await drive(owner, viewer, person.id, sqliteMessages(reader), options)
  } finally {
    reader.close()
    await server.stop(true)
    await core.close()
  }
}

async function drive(
  owner: KeithClient,
  viewer: KeithClient,
  personId: string,
  messages: MessageAdapter,
  options: PersonaRunOptions,
): Promise<PersonaRun> {
  const session = `front:${personId}`
  const spentBefore = (await owner.rpc.budget.get()).spentUsd
  const cost = async (): Promise<number> => (await owner.rpc.budget.get()).spentUsd - spentBefore
  const turnMs = options.turnMs ?? 60_000
  const results: PersonaCaseResult[] = []
  let previousBlock: string | undefined
  let aborted: PersonaRun['aborted']
  for (const item of PERSONA_CASES) {
    if (options.maxUsd !== undefined && (await cost()) > options.maxUsd) {
      aborted = 'max-usd'
      break
    }
    const setup = await runSetup(item, owner, viewer)
    // the persona the turn reads is the one stored now; a switch in this case makes the previous block stale
    const persona = await owner.rpc.persona.get()
    const block = escapedJson(renderPersonaBlock(persona.body))
    const staleBlock =
      previousBlock !== undefined && previousBlock !== block ? previousBlock : undefined
    previousBlock = block

    const callsBefore = options.capture().length
    const storedBefore = new Set(
      (await messages.load({ sessionId: session, limit: 200 })).map((m) => m.id),
    )
    for await (const _ of viewer.reply(item.prompt, session)) {
      // drain: the stream ends with the turn
    }
    const finished = await until(
      `the turn of ${item.id}`,
      () => messages.load({ sessionId: session, limit: 200 }),
      (stored) => stored.some((m) => !storedBefore.has(m.id) && isFinalAnswer(m)),
      turnMs,
    ).catch(() => undefined)
    if (finished === undefined) break
    const answer = finished
      .filter((m) => !storedBefore.has(m.id) && m.role === 'assistant')
      .flatMap((m) => textOf(m.parts))
      .join('\n')
    const prompts = options.capture().slice(callsBefore)
    const observation: TurnObservation = {
      answer,
      prompts,
      block,
      ...(staleBlock === undefined ? {} : { staleBlock }),
      ...(setup.refusal === undefined ? {} : { refusal: setup.refusal }),
      ...(item.setup === 'rule-style'
        ? { styleAddress: (await viewer.rpc.persona.style.get()).address }
        : {}),
    }
    results.push({
      id: item.id,
      prompt: item.prompt,
      answer,
      calls: prompts.length,
      checks: scoreTurn(item, observation),
    })
  }
  return {
    cases: results,
    runChecks: [styleNeverInPrompt(options.capture())],
    costUsd: await cost(),
    aborted,
    complete: aborted === undefined && results.length === PERSONA_CASES.length,
  }
}

/** The setup of one case. A refused style value is returned as the refusal, not thrown: the case scores it. */
async function runSetup(
  item: PersonaCase,
  owner: KeithClient,
  viewer: KeithClient,
): Promise<{ refusal?: { code?: string; reason?: string | null } }> {
  switch (item.setup) {
    case 'none':
      return {}
    case 'switch-friend':
      await owner.rpc.persona.setTemplate({ templateId: 'friend' })
      return {}
    case 'brevity-short':
      await viewer.rpc.persona.style.set({ patch: { brevity: 'short' } })
      return {}
    case 'rule-style':
      try {
        await viewer.rpc.persona.style.set({ patch: { address: RULE_STYLE } })
        return {}
      } catch (error) {
        // the wire code of a refusal (`BAD_REQUEST` is VALIDATION). The contract's input schema refuses an address first, so the
        // reason is in `data.issues` there; a service refusal carries it in `data.reason`
        const e = error as {
          code?: string
          data?: { reason?: string | null; issues?: Array<{ message?: string }> }
        }
        return {
          refusal: {
            ...(e.code === undefined ? {} : { code: e.code }),
            reason: e.data?.reason ?? e.data?.issues?.[0]?.message ?? null,
          },
        }
      }
    case 'speech-client': {
      // a client that declares speech only: the core chooses the speech mode for this person's turns
      const id = crypto.randomUUID()
      await viewer.rpc.presence.clients.register({
        id,
        kind: 'mobile',
        label: 'speech test client',
        capabilities: ['chat', 'notify', 'render.speech-only'],
        version: 'eval',
      })
      await viewer.rpc.presence.clients.heartbeat({ id, active: true })
      return {}
    }
  }
}

/** An assistant message with a finished text part: the final answer of a turn. */
function isFinalAnswer(m: { role: string; parts?: unknown[] }): boolean {
  return (
    m.role === 'assistant' &&
    (m.parts ?? []).some((p) => {
      const part = p as { type?: string; state?: string }
      return part.type === 'text' && part.state === 'done'
    })
  )
}

function textOf(parts: unknown[] | undefined): string[] {
  return (parts ?? []).flatMap((p) => {
    const part = p as { type?: string; text?: string }
    return part.type === 'text' && typeof part.text === 'string' ? [part.text] : []
  })
}
