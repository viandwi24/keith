import type { ClientRecord, PersonaBody, PersonStyle } from '@keith/contracts'
import type { TasksRepo } from '@keith/db'
import type {
  DeadInboxItem,
  InboxAdapter,
  MessageAdapter,
  StateAdapter,
  StreamLogAdapter,
} from 'eharness'
import {
  defineHarnessAgent,
  type HarnessAgent,
  type HarnessContext,
  type HarnessLogger,
  type HarnessPlugin,
  UNTRUSTED_CONTENT_INSTRUCTIONS,
} from 'eharness'
import { type ActivityStore, activity } from 'eharness/activity'
import { clock } from 'eharness/clock'
import { stepBudget } from 'eharness/limits'
import { frontSessionId } from '../../platform/sessions.ts'
import { aclGuard } from '../acl/index.ts'
import { brainEvents } from '../brain-events/index.ts'
import { type Budget, FRONT_TURN_BUDGET_USD } from '../budget/index.ts'
import type { Cortex } from '../cortex/index.ts'
import { hippocampus } from '../hippocampus/index.ts'
import { nodesStatus } from '../motor/index.ts'
import type { NodeRegistry } from '../nodes/index.ts'
import { appsOnlineLine } from '../parietal/index.ts'
import {
  createDocumentPlugin,
  createReportPlugin,
  modeForClients,
  modeText,
  type PersonaService,
  renderPersonaBlock,
  renderStyleLines,
  speakableGuard,
  templateToBody,
} from '../prefrontal/index.ts'
import {
  type ProviderService,
  resolveRoleModel,
  roleModel,
  unconfiguredModel,
} from '../providers/index.ts'
import { proactive } from '../ras/index.ts'
import { resumeConfig } from '../resume/index.ts'
import { taskReminder } from '../tasks/index.ts'
import { FRONT_CACHE } from './prompt-cache.ts'
import { frontSummarizeAt } from './summarize-at.ts'

export { frontSessionId }

/**
 * The core rules of the front agent: the same text for every person, kept verbatim, in the system prompt. The persona block (the
 * owner's character, `prefrontal/prompt.ts`) is the same for every person too, and comes in the turn reminder at each turn; the
 * per-person style lines come in the turn reminder of that person only.
 */
export const FRONT_INSTRUCTIONS = `You are Keith, a personal assistant. Each conversation is with one person; the turn reminder says who.
Never claim you did something you did not do. When you cannot do a task yet, say so plainly.
To answer whether a person is free or busy, use the presence tool: it returns only what that person shares, and you say nothing more.
Protocols are standing rules and reminder ladders that run on their own. Propose one (protocol_propose) only when the person asks for a standing rule or you notice a clear recurring need; say what it will do and that nothing runs until they confirm it. List or pause their protocols with protocol_list and protocol_pause, and answer a question a protocol asked with protocol_answer.
Answer craft (every persona): lead with the point: the action, then the reason, then the deadline. A briefing is a count first ("three things"), then each item with rounded figures and something to compare them with, then one closing line. Confirm a finished action in two to four words. After a refusal, repeat the key fact once and offer one yes/no next step. A message you start yourself says first why it interrupts.
${UNTRUSTED_CONTENT_INSTRUCTIONS}`

/** Added when the front agent has the agenda tools (`agenda_add`, `agenda_list`, `agenda_done`). */
export const AGENDA_INSTRUCTIONS = `Agenda: when the person says what they will do at a time or place (a meeting, a flight), call agenda_add with the time they said, as confirmed when the time and the meaning are clear. When the time or the meaning is unclear (for example "later" or "sometime next week"), ask one short question first and call agenda_add only after the answer; an item the person has not confirmed is stored as tentative. Never invent a time: store only a time the person said, resolving a relative day such as "tomorrow" with the datetime tool. agenda_list shows their upcoming items and agenda_done marks one finished.`

/** Added when the front agent can delegate (the `agent` tool exists). */
export const DELEGATION_INSTRUCTIONS = `Delegation: you have workers (the agent tool). Answer simple questions and chat yourself.
Delegate work that is long, needs research on the web, or has several steps: call the agent tool with a clear, self-contained prompt (the worker sees nothing of this chat), then tell the person in one short sentence that you are on it. Write the prompt in English, whatever language the chat is in, and end it with the language the result must be in: the language the person asked for, else the language their style sets, else the language they write to you in (for example "Write the report in Indonesian."). Workers run in the background, so they can keep talking to you meanwhile.
Never pretend to have results before a worker reports. When a worker's report arrives, tell the person the outcome yourself, in your own words, with the sources it gave; if it failed or was interrupted, say so plainly (a report "stopped: cost-cap" means the monthly spending limit was reached: tell them the limit must be raised (the owner can, with /budget)). If the person asks how a task is going, use the list of active tasks you are given, or agent_output.
Machines: nodes_status lists the machines paired with Keith (and "core", where you run) with their state. To do anything on a machine, such as checking a disk or running a command, delegate it to cortex.general with the node name and the exact task. Every shell command waits for approval (the owner's, when a member asks), so say that a command waits.`

/** Added when the front agent has `undo_last`: what to say after a change that runs at once (ADR-0036 §4). */
export const UNDO_INSTRUCTIONS = `Reversible changes (a persona, the person's style, a model role, their presence status) run at once when the person just asked for them: do the change, then say it is done in a few words and that "undo" switches back (for example "Done, sir. Say 'undo' to switch back."). When the person says undo, revert or switch back, call undo_last and say what it restored. If such a change waits for approval, say what you are about to do and wait.`

/**
 * Added when the front agent has the consent hook (ADR-0036 §4, docs/specs/wernicke-broca.md "Asking in conversation"): the person's
 * yes is read by the core from their next message, so the question must come first, in the turn, before the call.
 */
export const CONSENT_INSTRUCTIONS = `Asking first: before a call that may need the person's yes (a command that changes files, sends something, calls or pays, and anything you do after reading outside content such as a web page, a report or a note), say in one or two sentences what you are about to do, where and why, ending with exactly one yes/no question; then make the call in the same turn. The call waits for their answer, which the system reads from their next message. Never say it is done before it has run, and never answer the question yourself. A worker's request reaches you as an event: say it to the person the same way, with no tool call. If the call is denied, say so plainly and offer one next step.`

/** Steps of one front turn: a small base, extended in chunks up to the cap, then a hand-over. */
export const FRONT_STEPS = { base: 8, chunk: 8, cap: 16 } as const

const CAP_REMINDER =
  'You have used many steps in this turn. Do not start new work here: delegate the long work to Cortex (the agent tool) and tell the person you are on it.'

/** M4 hardening of the front agent (needs `delegation`: it uses the activity feed). */
export interface FrontHardening {
  /** Data folder of the core (memory lives in `<dataDir>/memory/<personId>`). */
  dataDir: string
  budget: Budget
  /** Stable id of this core (`resume.md`). */
  instanceId: string
  /** The dreaming flush line of a `compaction.before` hook (`hippocampus/dream/flush-hook.ts`, ADR-0031 §9). */
  dreamFlush?: HarnessPlugin
}

/** What the front agent is told about the person it talks to (from the session id's person). */
export interface PersonInfo {
  name: string
  username: string | null
  role: string
}
export type WhoIs = (personId: string) => Promise<PersonInfo | undefined>

/** The per-turn line naming the person (never throws: a failed lookup just says nothing more). */
export function whoText(person: PersonInfo | undefined): string | undefined {
  if (person === undefined) return undefined
  const clean = (t: string): string => t.replace(/\s+/g, ' ').slice(0, 80)
  const login = person.username === null ? '' : ` (username ${clean(person.username)})`
  return `You are talking to ${clean(person.name)}${login}, a ${person.role} of this Keith. Their memory and tasks are theirs alone.`
}

/** The persona body the front agent speaks with: the stored one, or the `professional` template when there is none or it cannot be read. */
export function personaBodyOf(persona: Pick<PersonaService, 'get'> | undefined): PersonaBody {
  try {
    return persona?.get()?.body ?? templateToBody('professional')
  } catch {
    return templateToBody('professional')
  }
}

export interface FrontAgentOptions {
  /** Who a person id is; names them in the turn reminder and in the memory label. */
  whois?: WhoIs
  /**
   * The persona (`prefrontal`): its block is read at every turn (`refresh: 'turn'`), so a change reaches the next turn.
   * Absent (or failing): the `professional` template's block.
   */
  persona?: Pick<PersonaService, 'get'>
  /**
   * The style of one person (`prefrontal`, read by the person's id): its lines go in that person's turn reminder only. Absent:
   * no style lines.
   */
  style?: (personId: string) => PersonStyle
  /**
   * The onboarding block of one person (`prefrontal`, ADR-0034 §4): defined only while that person has no stored style. It goes
   * in that person's turn reminder, after the style lines. Absent or failing: no block.
   */
  onboarding?: (personId: string) => Promise<string | undefined>
  /** The persona and style tools (`prefrontal/persona-tools.ts`): the front agent only, never a worker, room or guest. */
  personaTools?: HarnessPlugin
  /** The `undo_last` tool (`amygdala/undo.ts`): the front agent only. Its instruction line is added with it. */
  undoTool?: HarnessPlugin
  /** The consent hook plugin (`amygdala/consent.ts`, ADR-0036): decides `tool.approve` from risk and provenance. */
  consent?: HarnessPlugin
  /** The owner's model tools (`model_roles_get`, `model_role_set`; ADR-0034 §8): the front agent only. */
  modelTools?: HarnessPlugin
  /**
   * The clients of the turn's person (`parietal`, read only): the channel and the second screen choose the answer mode (P33.4.1).
   * Absent or failing: no client is known, so the mode is `chat` in plain text.
   */
  clients?: (personId: string) => readonly ClientRecord[]
  /**
   * The "Where the person is now" block of the person's client in use (`parietal`, docs/decisions/0033): read at each turn,
   * in that person's reminder only. Absent or failing: no block.
   */
  clientContext?: (personId: string) => string | undefined
  providers: ProviderService
  storage: {
    messages: MessageAdapter
    state: StateAdapter
    inbox?: InboxAdapter
    streams?: StreamLogAdapter
  }
  hardening?: FrontHardening
  /** Compiled Keith plugins (`modules/plugins`): their tools join the front agent's. */
  plugins?: HarnessPlugin[]
  /** The `presence` tool (`modules/parietal/tool.ts`): the front agent only, never a worker. */
  presence?: HarnessPlugin
  /** The `client_call` tool (`modules/parietal/client-tools.ts`): the front agent only, never a worker, room or guest. */
  clientCall?: HarnessPlugin
  /** The `workspace` tool (`modules/parietal/workspace-tool.ts`): the front agent only, never a worker, room or guest. */
  workspaceTool?: HarnessPlugin
  /**
   * The "On screen now" line of the person (`parietal`, ADR-0037 §5): what their workspace screen shows, read at each turn.
   * Absent, failing or undefined (no screen draws a workspace): no line.
   */
  onScreen?: (personId: string) => string | undefined
  /** The protocol tools (`modules/hypothalamus/tools.ts`): the front agent only, never a worker. */
  protocolTools?: HarnessPlugin
  /** The `room_post` tool (`modules/corpus-callosum/post.ts`): the front agent only, offered while the person is in a room. */
  roomPost?: HarnessPlugin
  /** The `activity-logs` plugin (`modules/audit/activity-logs`): records every model call of this agent (ADR-0032 §1). */
  activityLogs?: HarnessPlugin
  /** The data folder: the `document_save` tool writes the person's own documents here (`prefrontal/document-tool.ts`). */
  dataDir?: string
  timezone?: string
  logger?: HarnessLogger
  /** Inbox poll interval (ms): how soon a worker's report wakes the agent. Default 500. */
  inboxPollMs?: number
  /** Called when an inbox item is given up on after repeated failures. */
  onDeadLetter?: (item: DeadInboxItem) => void | Promise<void>
  /**
   * Delegation and the board. Without it the agent is the M1 chat agent (no tools besides the
   * clock); with it the agent also gets the activity feed, brain events, the proactive mark, the
   * task reminder and the `agent` tool.
   */
  delegation?: {
    cortex: Cortex
    tasks: TasksRepo
    store: ActivityStore
    /** This agent, for the delegation plugin (it reports back to it). */
    self: () => HarnessAgent
    /** The machines: the front agent only reads their state (`nodes_status`). */
    nodes: NodeRegistry
  }
}

/**
 * Wernicke–Broca: the front agent that understands and answers. Its model is the `front` role,
 * resolved on every turn by `roleModel`; until one is picked, turns fail with a readable message.
 */
export function createFrontAgent(options: FrontAgentOptions): HarnessAgent {
  const d = options.delegation
  const h = d === undefined ? undefined : options.hardening
  return defineHarnessAgent({
    id: 'front',
    model: unconfiguredModel('front'),
    models: options.providers.catalog(),
    instructions: [
      [
        d === undefined ? FRONT_INSTRUCTIONS : `${FRONT_INSTRUCTIONS}\n${DELEGATION_INSTRUCTIONS}`,
        ...(options.protocolTools === undefined ? [] : [AGENDA_INSTRUCTIONS]),
        ...(options.undoTool === undefined ? [] : [UNDO_INSTRUCTIONS]),
        ...(options.consent === undefined ? [] : [CONSENT_INSTRUCTIONS]),
      ].join('\n'),
      // the persona block: read from the current persona at every turn, so an owner's change (a template, an edit, a restore)
      // reaches the next turn at once. The text is the same for every person; it is not cached in the session, because an
      // open session would keep the text of its first turn (docs/specs/prefrontal.md "Harness check")
      {
        refresh: 'turn' as const,
        text: async (): Promise<string> => renderPersonaBlock(personaBodyOf(options.persona)),
      },
      ...(options.whois === undefined
        ? []
        : [
            {
              refresh: 'turn' as const,
              text: async (ctx: HarnessContext): Promise<string | undefined> => {
                try {
                  const id = ctx.principal?.id
                  return id === undefined ? undefined : whoText(await options.whois?.(id))
                } catch {
                  return undefined
                }
              },
            },
          ]),
      // the style lines of the turn's person: in the turn reminder, never in the system prompt (ADR-0029 §3)
      ...(options.style === undefined
        ? []
        : [
            {
              refresh: 'turn' as const,
              text: async (ctx: HarnessContext): Promise<string | undefined> => {
                try {
                  const id = ctx.principal?.id
                  if (id === undefined || options.style === undefined) return undefined
                  const name = (await options.whois?.(id))?.name
                  return renderStyleLines(options.style(id), name)
                } catch {
                  return undefined
                }
              },
            },
          ]),
      // onboarding of a person with no stored style: that person's reminder only, gone once a style row exists (ADR-0034 §4)
      ...(options.onboarding === undefined
        ? []
        : [
            {
              refresh: 'turn' as const,
              text: async (ctx: HarnessContext): Promise<string | undefined> => {
                try {
                  const id = ctx.principal?.id
                  return id === undefined ? undefined : await options.onboarding?.(id)
                } catch {
                  return undefined
                }
              },
            },
          ]),
      // the client in use of the turn's person: host, OS, device, network and local time (docs/decisions/0033 §5)
      ...(options.clientContext === undefined
        ? []
        : [
            {
              refresh: 'turn' as const,
              text: async (ctx: HarnessContext): Promise<string | undefined> => {
                try {
                  const id = ctx.principal?.id
                  return id === undefined ? undefined : options.clientContext?.(id)
                } catch {
                  return undefined
                }
              },
            },
          ]),
      // the apps online for the turn's person: the live list of `client_call` (audit F9). It is here, not in the tool description,
      // so a client that connects or disconnects does not change the tools of the prompt (docs/specs/parietal.md)
      ...(options.clientCall === undefined
        ? []
        : [
            {
              refresh: 'turn' as const,
              text: async (ctx: HarnessContext): Promise<string> => {
                try {
                  const id = ctx.principal?.id
                  return appsOnlineLine(id === undefined ? [] : (options.clients?.(id) ?? []))
                } catch {
                  return appsOnlineLine([])
                }
              },
            },
          ]),
      // what the person's workspace screen shows now (ADR-0037 §5): titles quoted as data, no line when no screen draws one
      ...(options.workspaceTool === undefined || options.onScreen === undefined
        ? []
        : [
            {
              refresh: 'turn' as const,
              text: async (ctx: HarnessContext): Promise<string | undefined> => {
                try {
                  const id = ctx.principal?.id
                  return id === undefined ? undefined : options.onScreen?.(id)
                } catch {
                  return undefined
                }
              },
            },
          ]),
      // the mode block of the turn, last in the reminder: fixed text chosen in code from the person's channel (P33.4.1, ADR-0029 §5)
      {
        refresh: 'turn' as const,
        text: async (ctx: HarnessContext): Promise<string | undefined> => {
          try {
            const id = ctx.principal?.id
            return modeText(
              modeForClients(id === undefined ? [] : (options.clients?.(id) ?? []), 'chat'),
            )
          } catch {
            return modeText(modeForClients([], 'chat'))
          }
        },
      },
    ],
    plugins: [
      roleModel('front', options.providers),
      aclGuard(),
      // the speakable guard (P33.4.2): flattens the saved answer of a speech channel; any other channel is unchanged
      speakableGuard({ clients: (personId) => options.clients?.(personId) ?? [] }),
      ...(options.plugins ?? []),
      ...(options.presence === undefined ? [] : [options.presence]),
      ...(options.clientCall === undefined ? [] : [options.clientCall]),
      ...(options.workspaceTool === undefined ? [] : [options.workspaceTool]),
      ...(options.protocolTools === undefined ? [] : [options.protocolTools]),
      ...(options.personaTools === undefined ? [] : [options.personaTools]),
      ...(options.modelTools === undefined ? [] : [options.modelTools]),
      ...(options.undoTool === undefined ? [] : [options.undoTool]),
      ...(options.consent === undefined ? [] : [options.consent]),
      ...(options.roomPost === undefined ? [] : [options.roomPost]),
      ...(options.dataDir === undefined
        ? []
        : [
            createDocumentPlugin({ dataDir: options.dataDir }),
            // the report block of a worker's result, and the saved path of a long one (P33.4.4)
            createReportPlugin({
              dataDir: options.dataDir,
              ...(options.logger === undefined
                ? {}
                : { warn: (message: string) => options.logger?.warn(message) }),
            }),
          ]),
      clock({ timezone: options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone }),
      ...(d === undefined
        ? []
        : [
            activity({ store: d.store, messages: false }),
            brainEvents({ store: d.store, role: 'front' }),
            proactive({ store: d.store }),
            taskReminder({ tasks: d.tasks }),
            nodesStatus({ nodes: d.nodes }),
            d.cortex.leadPlugin(d.self),
          ]),
      ...(d === undefined || h === undefined
        ? []
        : [
            ...hippocampus({
              dataDir: h.dataDir,
              store: d.store,
              ...(options.whois === undefined
                ? {}
                : { nameOf: async (id: string) => (await options.whois?.(id))?.name }),
              flushOnCompaction: true,
              ...(options.logger === undefined
                ? {}
                : { warn: (message: string) => options.logger?.warn(message) }),
            }),
            // the second `compaction.before` hook: its flush line joins the memory plugin's (ADR-0031 §9)
            ...(h.dreamFlush === undefined ? [] : [h.dreamFlush]),
            h.budget.notice(),
            stepBudget({
              chunk: FRONT_STEPS.chunk,
              cap: FRONT_STEPS.cap,
              onCap: { reminder: CAP_REMINDER },
            }),
          ]),
      ...(options.activityLogs === undefined ? [] : [options.activityLogs]),
    ],
    ...(h === undefined
      ? {}
      : {
          ...resumeConfig(h.instanceId),
          budget: h.budget.config({ maxTurnUsd: FRONT_TURN_BUDGET_USD }),
          compaction: {
            // the summary and the memory flush run on the front role's model of the moment, with DeepSeek thinking off
            // (a summary needs no reasoning: audit F7, providers/thinking.ts)
            model: () => resolveRoleModel('front', options.providers, 'compaction'),
            // the ratio of the window, capped at 200k tokens (audit F14, summarize-at.ts)
            summarizeAt: frontSummarizeAt(options.providers),
            keepLast: 6,
            prune: { keepTurns: 2, minChars: 2000 },
          },
          toolOutput: { maxChars: 20_000 },
          loop: { maxSteps: FRONT_STEPS.base },
        }),
    // the turn reminder trails the newest message, so turn N+1 starts with turn N's exact bytes (eharness 0.13.0, ADR-0073, audit F8)
    reminders: { turnPlacement: 'end' },
    // breakpoints before the trailing reminder, also for Claude through OpenRouter (eharness 0.14.0 cache.include)
    cache: FRONT_CACHE,
    storage: options.storage,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    inbox: {
      pollMs: options.inboxPollMs ?? 500,
      ...(options.onDeadLetter === undefined ? {} : { onDeadLetter: options.onDeadLetter }),
    },
  })
}
