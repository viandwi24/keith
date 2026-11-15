// The `client_call` tool of the front agent (docs/specs/node-drivers.md, "Client capabilities"; ADR-0023 §5, ADR-0020 §3).
// It asks one of the turn's own person's clients to do a capability. The person is never an argument: the tool reads
// `ctx.principal` when it runs and calls `parietal.callClient` for that person only. A worker, a room agent and a guest
// agent never get it (`modules/wernicke-broca/agent.ts` adds the plugin to the front agent alone).
import type { ClientRecord } from '@keith/contracts'
import { tool } from 'ai'
import { definePlugin, type HarnessContext, type HarnessPlugin } from 'eharness'
import { z } from 'zod'
import type { AclActors } from '../acl/index.ts'
import type { Audit } from '../audit/index.ts'
import {
  CLIENT_CAPABILITIES,
  CLIENT_CAPABILITY_IDS,
  type ClientCapabilityId,
  isClientCapabilityId,
} from './capabilities.ts'
import type { ParietalService } from './service.ts'

export const CLIENT_CALL_TOOL = 'client_call'

/** What the tool answers: the client that did it (its label) and its text answer, or why nothing was done. */
export type ClientCallResult =
  | { ok: true; client: string; result?: string }
  | { ok: false; code: 'no-client' | 'failed'; message: string }

const NO_CLIENT: ClientCallResult = {
  ok: false,
  code: 'no-client',
  message:
    'no app of yours is online that can do this; open the Keith app on the device you want to use',
}

/**
 * The answer when the capability has no online app at call time: it names the capabilities that ARE online for the person
 * and tells the model not to retry this one in the turn (the schema keeps every capability, so the model may try again).
 */
export function noClientFor(
  parietal: Pick<ParietalService, 'list'>,
  personId: string,
  capability: ClientCapabilityId,
): ClientCallResult {
  const online = onlineCapabilities(parietal, personId).filter((cap) => cap !== capability)
  const listed = online.length === 0 ? 'none' : online.join(', ')
  return {
    ok: false,
    code: 'no-client',
    message: `no app of yours is online with "${capability}" now. Capabilities online for you now: ${listed}. Do not call "${capability}" again in this turn; use an online capability or answer without it.`,
  }
}

/** The valid capability ids the person's online clients announced, in the registry's order. */
function onlineCapabilities(
  parietal: Pick<ParietalService, 'list'>,
  personId: string,
): ClientCapabilityId[] {
  return onlineCapabilitiesOf(parietal.list(personId))
}

function onlineCapabilitiesOf(clients: readonly ClientRecord[]): ClientCapabilityId[] {
  const online = new Set<ClientCapabilityId>()
  for (const client of clients)
    if (client.online)
      for (const cap of client.capabilities) if (isClientCapabilityId(cap)) online.add(cap)
  return CLIENT_CAPABILITY_IDS.filter((cap) => online.has(cap))
}

export interface ClientCallToolOptions {
  parietal: Pick<ParietalService, 'list' | 'presence' | 'callClient'>
  /** Reads the principal's person from the directory now (a principal that is not an active person gets no client). */
  actors: AclActors
  /** Writes `client.call` (`{ person, capability, ok }`, no input and no output). Absent in tests that do not audit. */
  audit?: Pick<Audit, 'record'>
  /** A fresh id per delivery (a test passes a fixed one). */
  newId?: () => string
}

/**
 * The clients of one person that announced the capability and are online: the active one first, then the most recently
 * active. Only the person's own clients are ever listed (the list is read for that person).
 */
export function clientsFor(
  parietal: Pick<ParietalService, 'list' | 'presence'>,
  personId: string,
  capability: ClientCapabilityId,
): ClientRecord[] {
  const active = parietal.presence(personId).activeClient
  return parietal
    .list(personId)
    .filter((c) => c.online && c.capabilities.includes(capability))
    .sort(
      (a, b) =>
        Number(b.id === active) - Number(a.id === active) ||
        (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0),
    )
}

/** The input each capability takes, as the model reads it in the tool description. */
const INPUT_HINT: Record<ClientCapabilityId, string> = {
  notify: 'shows a notice with input {text, title?, level?}',
  'open.view': 'opens a view with input {view, args?}',
  'location.share': 'asks for the coarse location the person chose to share, input {precision}',
}

/**
 * The tool description: one fixed text, so the tools of the prompt never change when a client connects or disconnects (audit F9,
 * docs/specs/parietal.md). The capabilities online for the person are NOT here: they are in the turn reminder line
 * `appsOnlineLine` writes, and a capability not listed there is unavailable.
 */
export const CLIENT_CALL_DESCRIPTION =
  'Ask one of the signed-in person\'s own apps (their clients) to do something on its screen. The call reaches only the person you are talking to. The answer names the app that did it and its text answer, or says that no app is online for it. The turn reminder line "Apps online now" lists the capabilities online for this person now, with their input; a capability not listed there is unavailable, so do not call this tool for it.'

/**
 * The per-turn reminder line that lists the capabilities an online app of the person has now, with the input each takes. It
 * is the only place the live list appears (the tool description stays fixed). Written by the front agent at each turn.
 */
export function appsOnlineLine(clients: readonly ClientRecord[]): string {
  const listed = onlineCapabilitiesOf(clients)
  if (listed.length === 0)
    return 'Apps online now: none. Every client_call capability is unavailable: do not call client_call to show or open anything.'
  const hints = listed.map((cap) => `"${cap}" ${INPUT_HINT[cap]}`).join('; ')
  return `Apps online now: ${listed.join(', ')}. ${hints}. A capability not listed is unavailable.`
}

/** The tool of one turn: `ctx.principal` is read when the tool runs, so the person is the one who asked. */
export function clientCallToolOf(options: ClientCallToolOptions) {
  const newId = options.newId ?? (() => crypto.randomUUID())
  return (ctx: HarnessContext) =>
    tool({
      description: CLIENT_CALL_DESCRIPTION,
      inputSchema: z.object({
        capability: z.enum(CLIENT_CAPABILITY_IDS),
        input: z.record(z.string(), z.unknown()),
      }),
      metadata: { risk: 'write', source: 'trusted' },
      execute: async ({
        capability,
        input,
      }: {
        capability: ClientCapabilityId
        input: Record<string, unknown>
      }): Promise<ClientCallResult> => {
        let personId: string | undefined
        try {
          personId = (await options.actors.of(ctx.principal))?.id
        } catch {
          personId = undefined
        }
        if (personId === undefined) return NO_CLIENT

        const parsed = CLIENT_CAPABILITIES[capability].input.safeParse(input)
        if (!parsed.success) {
          const issue = parsed.error.issues[0]?.message ?? 'the input is not valid'
          return {
            ok: false,
            code: 'failed',
            message: `the input does not fit ${capability}: ${issue}`,
          }
        }

        let answer: ClientCallResult = noClientFor(options.parietal, personId, capability)
        try {
          for (const client of clientsFor(options.parietal, personId, capability)) {
            const call = await options.parietal.callClient(personId, capability, parsed.data, {
              clientId: client.id,
              deliveryId: `client_call:${newId()}`,
              name: CLIENT_CALL_TOOL,
            })
            if (call.ok) {
              answer = {
                ok: true,
                client: client.label,
                ...(call.result === undefined ? {} : { result: call.result }),
              }
              break
            }
          }
        } catch {
          answer = noClientFor(options.parietal, personId, capability)
        }
        options.audit?.record({
          kind: 'client.call',
          actor: personId,
          via: 'local',
          detail: { person: personId, capability, ok: answer.ok },
        })
        return answer
      },
    })
}

/** Plugin of `client_call`: added to the front agent only (`modules/wernicke-broca/agent.ts`). */
export function clientCallTool(
  options: ClientCallToolOptions,
): HarnessPlugin<'keith-parietal-client-call'> {
  return definePlugin({
    name: 'keith-parietal-client-call',
    setup: () => ({ tools: { [CLIENT_CALL_TOOL]: clientCallToolOf(options) } }),
  })
}
