// The agent tools of the front agent (docs/specs/hypothalamus.md, "Agent tools"): `protocol_propose`, `protocol_list`,
// `protocol_pause` and `protocol_answer`. Each runs as the turn's principal (`ctx.principal`, ADR-0020 §2), resolved through
// the ACL actors now: no argument names a person, so a tool cannot be pointed at another one. `protocol_propose` writes a
// proposal, never a protocol (ADR-0024 §3). A refusal is an answer `{ ok: false, reason, message }`, not a thrown error, so
// the model can tell the person what happened. The worker and room sessions never get this plugin (`createFrontAgent`).
import { capabilitiesOf, ProposalDefinitionSchema } from '@keith/contracts'
import type { ProtocolRunsRepo, ProtocolsRepo } from '@keith/db'
import { tool } from 'ai'
import { definePlugin, type HarnessContext } from 'eharness'
import { z } from 'zod'
import type { AclActors } from '../acl/index.ts'
import type { AgendaService } from './agenda.ts'
import type { AnswerOutcome, AnswerInput as EngineAnswer } from './drive.ts'
import type { ProtocolEngine } from './engine.ts'
import type { ProposalService } from './proposals.ts'
import type { ProtocolCaller, ProtocolService } from './service.ts'
import { ProtocolError } from './views.ts'

export const PROTOCOL_TOOL_PLUGIN = 'keith-hypothalamus-tools'

const SEVEN_DAYS_MS = 7 * 24 * 3_600_000

/** What the tools call: the same service functions a person's RPC call reaches. */
export interface ProtocolToolPorts {
  service: Pick<ProtocolService, 'pause' | 'setEnabled'>
  proposals: Pick<ProposalService, 'propose' | 'proposals'>
  protocols: Pick<ProtocolsRepo, 'get' | 'list'>
  runs: Pick<ProtocolRunsRepo, 'get'>
  engine: Pick<ProtocolEngine, 'answer'>
  agenda: Pick<AgendaService, 'add' | 'list' | 'done'>
}

export interface Refusal {
  ok: false
  reason: string
  message: string
}

const refusal = (reason: string, message: string): Refusal => ({ ok: false, reason, message })

/** The caller of a tool: the turn's person, with the capabilities of the role (authoring needs `chat`). */
async function callerOf(actors: AclActors, ctx: HarnessContext): Promise<ProtocolCaller | Refusal> {
  const actor = await actors.of(ctx.principal)
  if (actor === undefined || actor.kind !== 'user' || actor.role === null) {
    return refusal('no-person', 'there is no person this turn acts for')
  }
  return { id: actor.id, role: actor.role, capabilities: capabilitiesOf(actor.role), via: 'local' }
}

/**
 * Runs `act` as the turn's person. Not ready (the ports are bound at boot), no person, or a refusal of the service (a
 * `ProtocolError`) each answer a `Refusal`; any other error is a bug and is thrown.
 */
async function asCaller<T>(
  actors: AclActors,
  ports: () => ProtocolToolPorts | undefined,
  ctx: HarnessContext,
  act: (ports: ProtocolToolPorts, caller: ProtocolCaller) => T | Promise<T>,
): Promise<T | Refusal> {
  const bound = ports()
  if (bound === undefined) return refusal('unavailable', 'protocols are not ready yet')
  const caller = await callerOf(actors, ctx)
  if ('ok' in caller) return caller
  try {
    return await act(bound, caller)
  } catch (error) {
    if (error instanceof ProtocolError) return refusal(error.reason ?? error.code, error.message)
    throw error
  }
}

const ProposeInput = z.object({
  reason: z
    .string()
    .min(1)
    .max(200)
    .describe('one line the person reads: what the protocol does and why it is suggested'),
  definition: ProposalDefinitionSchema.describe(
    'the protocol: trigger, conditions, steps (notify, ask, wake, wait, branches) and limits; no act step',
  ),
})

const ListInput = z.object({})

const PauseInput = z.object({
  id: z.string().min(1).max(64).describe('the id of one of the person protocols'),
  until: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe('an ISO 8601 time the pause ends; omit to switch the protocol off'),
})

/** Times are ISO 8601 strings the model writes from what the person said; the tool turns them into epoch ms. */
const AgendaAddTool = z.object({
  what: z.string().min(1).max(200).describe('what the person will do, in their words'),
  startsAt: z
    .string()
    .min(1)
    .max(40)
    .describe('when it starts, ISO 8601 with the offset; only a time the person said'),
  endsAt: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe('when it ends, ISO 8601 with the offset, when the person said it'),
  place: z.string().min(1).max(120).optional().describe('where, when the person said it'),
  status: z
    .enum(['tentative', 'confirmed'])
    .default('tentative')
    .describe(
      'confirmed when the time and the meaning are clear; tentative otherwise (ask the person first when unsure)',
    ),
})

const AgendaListTool = z.object({
  from: z.string().min(1).max(40).optional().describe('ISO 8601; default now'),
  to: z.string().min(1).max(40).optional().describe('ISO 8601; default seven days from now'),
})

const AgendaDoneTool = z.object({
  id: z.string().min(1).max(64).describe('the id of one of the person agenda items'),
})

const AnswerInput = z.object({
  runId: z.string().min(1).max(64).describe('the run that asked the question'),
  option: z.string().min(1).max(80).optional().describe('the chosen option, when it has options'),
  text: z.string().min(1).max(1000).optional().describe('the answer in the person words'),
})

/** The four tools, each a function of the turn's context (the presence tool's pattern, `modules/parietal/tool.ts`). */
export function protocolToolsOf(actors: AclActors, ports: () => ProtocolToolPorts | undefined) {
  return {
    protocol_propose: (ctx: HarnessContext) =>
      tool({
        description:
          'Suggest a protocol (a standing rule or a reminder ladder) to the person. It is only a suggestion: nothing runs until the person confirms it. Use it only when the person asks for a standing rule or you see a clear recurring need.',
        inputSchema: ProposeInput,
        metadata: { risk: 'write', source: 'trusted' },
        execute: (input: z.infer<typeof ProposeInput>) =>
          asCaller(actors, ports, ctx, (p, caller) => {
            const proposal = p.proposals.propose(caller, {
              definition: input.definition,
              reason: input.reason,
              source: { session: ctx.session.id, message: ctx.turn?.id ?? null },
            })
            return {
              ok: true,
              proposal: proposal.id,
              status: 'pending',
              note: 'Waiting for the person to confirm it; nothing runs before that.',
            }
          }),
      }),

    protocol_list: (ctx: HarnessContext) =>
      tool({
        description:
          'List the protocols of the person and the suggestions still waiting for their answer.',
        inputSchema: ListInput,
        metadata: { risk: 'read', source: 'trusted' },
        execute: () =>
          asCaller(actors, ports, ctx, async (p, caller) => ({
            ok: true,
            protocols: p.protocols.list(caller.id).map((row) => ({
              id: row.id,
              name: row.name,
              enabled: row.enabled,
              pausedUntil: row.pausedUntil,
              version: row.version,
            })),
            proposals: (await p.proposals.proposals(caller))
              .filter((item) => item.status === 'pending')
              .map((item) => ({ id: item.id, reason: item.reason, expiresAt: item.expiresAt })),
          })),
      }),

    protocol_pause: (ctx: HarnessContext) =>
      tool({
        description:
          'Pause one of the person protocols until a time, or switch it off when no time is given. Only the person own protocols can be changed.',
        inputSchema: PauseInput,
        metadata: { risk: 'write', source: 'trusted' },
        execute: (input: z.infer<typeof PauseInput>) =>
          asCaller(actors, ports, ctx, (p, caller) => {
            const row = p.protocols.get(input.id)
            if (row === undefined || row.owner !== caller.id) {
              return refusal('not-found', 'there is no such protocol')
            }
            if (input.until === undefined) {
              p.service.setEnabled(caller, input.id, false)
              return { ok: true, id: input.id, enabled: false }
            }
            const until = Date.parse(input.until)
            if (Number.isNaN(until)) return refusal('bad-time', 'the pause needs an ISO 8601 time')
            p.service.pause(caller, input.id, until)
            return { ok: true, id: input.id, pausedUntil: until }
          }),
      }),

    agenda_add: (ctx: HarnessContext) =>
      tool({
        description:
          'Add something the person will do at a time or place to their agenda. Store only a time the person said; never invent one. Ask one short question first when the time or the meaning is unclear, and call this only after the answer.',
        inputSchema: AgendaAddTool,
        metadata: { risk: 'write', source: 'trusted' },
        execute: (input: z.infer<typeof AgendaAddTool>) =>
          asCaller(actors, ports, ctx, (p, caller) => {
            const startsAt = Date.parse(input.startsAt)
            const endsAt = input.endsAt === undefined ? undefined : Date.parse(input.endsAt)
            if (Number.isNaN(startsAt) || (endsAt !== undefined && Number.isNaN(endsAt))) {
              return refusal('bad-time', 'the agenda needs ISO 8601 times')
            }
            if (endsAt !== undefined && endsAt <= startsAt) {
              return refusal('bad-time', 'the end is later than the start')
            }
            const added = p.agenda.add(
              caller,
              {
                what: input.what,
                startsAt,
                ...(endsAt === undefined ? {} : { endsAt }),
                ...(input.place === undefined ? {} : { place: input.place }),
                status: input.status ?? 'tentative',
              },
              { session: ctx.session.id, message: ctx.turn?.id ?? null },
            )
            return {
              ok: true,
              id: added.item.id,
              status: added.item.status,
              ...(added.proposal === null
                ? {}
                : {
                    proposal: {
                      id: added.proposal.id,
                      reason: added.proposal.reason,
                    },
                    note: 'A "keep quiet" suggestion waits for the person to confirm it; nothing runs before that.',
                  }),
            }
          }),
      }),

    agenda_list: (ctx: HarnessContext) =>
      tool({
        description:
          'List the agenda items of the person in a window (by default from now to seven days ahead).',
        inputSchema: AgendaListTool,
        metadata: { risk: 'read', source: 'trusted' },
        execute: (input: z.infer<typeof AgendaListTool>) =>
          asCaller(actors, ports, ctx, (p, caller) => {
            const from = input.from === undefined ? Date.now() : Date.parse(input.from)
            const to = input.to === undefined ? from + SEVEN_DAYS_MS : Date.parse(input.to)
            if (Number.isNaN(from) || Number.isNaN(to)) {
              return refusal('bad-time', 'the agenda needs ISO 8601 times')
            }
            return {
              ok: true,
              items: p.agenda.list(caller, { from, to }).map((item) => ({
                id: item.id,
                what: item.what,
                startsAt: new Date(item.startsAt).toISOString(),
                endsAt: item.endsAt === null ? null : new Date(item.endsAt).toISOString(),
                place: item.place,
                status: item.status,
              })),
            }
          }),
      }),

    agenda_done: (ctx: HarnessContext) =>
      tool({
        description: 'Mark one of the person agenda items as done.',
        inputSchema: AgendaDoneTool,
        metadata: { risk: 'write', source: 'trusted' },
        execute: (input: z.infer<typeof AgendaDoneTool>) =>
          asCaller(actors, ports, ctx, (p, caller) => {
            const item = p.agenda.done(caller, input.id)
            return { ok: true, id: item.id, status: item.status }
          }),
      }),

    protocol_answer: (ctx: HarnessContext) =>
      tool({
        description:
          'Answer a question a protocol asked the person in chat. Pass the run id from the question and the option or the text the person chose.',
        inputSchema: AnswerInput,
        metadata: { risk: 'write', source: 'trusted' },
        execute: (input: z.infer<typeof AnswerInput>) =>
          asCaller(actors, ports, ctx, async (p, caller) => {
            const run = p.runs.get(input.runId)
            if (run === undefined || run.person !== caller.id) {
              return refusal('not-found', 'there is no such question')
            }
            const outcome = await p.engine.answer({
              runId: input.runId,
              by: caller.id,
              ...(input.option === undefined ? {} : { option: input.option }),
              ...(input.text === undefined ? {} : { text: input.text }),
            })
            if (outcome.status !== 'answered') {
              return refusal(outcome.status, 'the question is not open for an answer')
            }
            return { ok: true, runId: input.runId, status: 'answered' }
          }),
      }),
  }
}

/**
 * The plugin of the four tools, and the slot the services are bound into once they exist (the front agent is built
 * before the protocol services; a tool reads the slot at call time). `bind` merges what it is given.
 */
export function protocolToolSlot(actors: AclActors) {
  let bound: Partial<ProtocolToolPorts> = {}
  const ports = (): ProtocolToolPorts | undefined => {
    const { service, proposals, protocols, runs, engine, agenda } = bound
    return service && proposals && protocols && runs && engine && agenda
      ? { service, proposals, protocols, runs, engine, agenda }
      : undefined
  }
  return {
    plugin: definePlugin({
      name: PROTOCOL_TOOL_PLUGIN,
      setup: () => ({ tools: protocolToolsOf(actors, ports) }),
    }),
    bind(more: Partial<ProtocolToolPorts>): void {
      bound = { ...bound, ...more }
    },
    /** The engine's answer through the bound engine: the RPC `protocols.answer` reaches the same call as the tool. */
    answer(input: EngineAnswer): Promise<AnswerOutcome> {
      if (bound.engine === undefined) throw new Error('the protocol engine is not bound yet')
      return bound.engine.answer(input)
    },
  }
}

export type ProtocolToolSlot = ReturnType<typeof protocolToolSlot>
