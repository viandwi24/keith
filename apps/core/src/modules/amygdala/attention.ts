import { type ConsentTier, driverOf, STEP_UP_TOOLS } from '@keith/contracts'
import type { TasksRepo } from '@keith/db'
import type { HarnessAgent, SessionLock } from 'eharness'
import type { ActivityStore, AttentionAnswer } from 'eharness/activity'
import type { HarnessHttpOptions } from 'eharness/http'
import { redactString } from '../../platform/logger.ts'
import {
  type FrontGenerationOf,
  frontSessionId,
  frontSessionOptions,
  peopleFor,
  personOfSession,
} from '../../platform/sessions.ts'
import { type Principal, stepUpDenial } from '../auth/index.ts'
import type { Cortex } from '../cortex/index.ts'
import { motorAskOf, ownerAnswers } from '../motor/index.ts'
import type { NodeCapabilityRegistry } from '../nodes/index.ts'
import type { PeopleService } from '../people/index.ts'
import type { ConsentRegistry } from './consent.ts'
import type { ApprovalSettings } from './settings.ts'

/**
 * What an approval is, as the owner reads it before answering (the audit row of the answer): the node, the
 * capability and the command, the command redacted and capped at `APPROVAL_COMMAND_MAX` characters.
 */
export interface ApprovalDescription {
  node: string
  capability: string
  /** The driver that provides the capability (the first segment of its id). */
  driver?: string
  command?: string
}

export const APPROVAL_COMMAND_MAX = 200

/** The answer routes' trail: what an approval is (read before the answer) and the remember scope applied. */
export interface AttentionTrail {
  describeApproval(sessionId: string, attentionId: string): Promise<ApprovalDescription | undefined>
  /** The remember scope the last answer of this approval applied (`once` when none was kept); undefined if unknown. */
  appliedRemember(sessionId: string, attentionId: string): string | undefined
}

export type AttentionOptions = NonNullable<HarnessHttpOptions<Principal>['attention']> &
  AttentionTrail

export interface AttentionDeps {
  /** The front agent (read lazily: it is built after the workers). */
  lead: () => HarnessAgent
  cortex: Cortex
  tasks: TasksRepo
  /** Who exists: the owner's roots include every member's front session (high-risk items only). */
  people: Pick<PeopleService, 'list' | 'get'>
  store: ActivityStore
  /** The shared session lock, passed when a root session is opened. */
  lock?: SessionLock
  /** The approval lifetime: the list shows each item's `expiresAt` (absent: the list shows no expiry). */
  approvals?: Pick<ApprovalSettings, 'ttlMs'>
  /** The capability registry of the core (default: the built-ins): who answers an approval reads it. */
  capabilities?: NodeCapabilityRegistry
  /** The current front generation of each person (ADR-0030 §2): the session a person's events go to. */
  generations: FrontGenerationOf
  /** How each waiting call is confirmed (ADR-0036): the items carry `consent`. Absent: the items carry none. */
  consent?: Pick<ConsentRegistry, 'tierOf'>
  /** The lifetime of a request asked in conversation (ms): its item's `expiresAt` counts from it, not from the approval lifetime. */
  conversationTtlMs?: () => number
}

/** The code of a refusal: the item waits for the owner and this person is not the owner. */
export const WAITING_FOR_OWNER = 'KEITH_WAITING_FOR_OWNER'

/** A worker of a session: the agent `hint` names, else the one of its task row. */
const workerOfSession = (
  deps: AttentionDeps,
  sessionId: string,
  hint?: string,
): HarnessAgent | undefined => deps.cortex.worker(hint ?? deps.tasks.get(sessionId)?.agent ?? '')

/** The front session is the only root; a worker session is `<parent>:agent:<id>` and has a task row. */
const isFrontSession = (deps: AttentionDeps, sessionId: string): boolean =>
  !sessionId.includes(':agent:') && deps.tasks.get(sessionId) === undefined

/**
 * The live session of the queue that owns an item, for writing: the front lead's, or the worker's
 * that runs it. Shared by the answer routes and the expiry sweeper (`expiry.ts`).
 */
export function openQueueSession(deps: AttentionDeps, sessionId: string) {
  if (isFrontSession(deps, sessionId))
    return deps.lead().session(sessionId, frontSessionOptions(sessionId, deps.lock))
  const worker = workerOfSession(deps, sessionId)
  if (worker === undefined) throw new Error(`no agent runs session ${sessionId}`)
  return worker.session(sessionId)
}

/**
 * Options of `/attention*` for `createHarnessHttp` (docs/specs/amygdala.md). A person's roots are
 * their own front session; the owner's also include every other person's front session, but only
 * the items the owner answers (`ownerAnswers`: a member's `shell.exec`) show there. A member sees
 * such an item in their own list marked `waitingFor: 'owner'` and cannot answer it. Answering one
 * from a remote client needs a step-up. Each session is read and answered on the agent that runs it.
 */
export function attentionOptions(deps: AttentionDeps): AttentionOptions {
  /** The remember scope each answered approval applied, kept until the audit reads it (bounded). */
  const applied = new Map<string, string>()
  const trailKey = (sessionId: string, attentionId: string) => `${sessionId}|${attentionId}`
  const workerOf = (sessionId: string, hint?: string) => workerOfSession(deps, sessionId, hint)
  /** Whether the owner answers a call under the core's capability registry (`ownerAnswers`). */
  const owned = (toolName: string, input: unknown) =>
    ownerAnswers(toolName, input, deps.capabilities)
  const isFront = (sessionId: string) => isFrontSession(deps, sessionId)
  /**
   * Whose session this is: `front:<id>` from the id; a worker session only through its task row
   * (a worker id with no task is nobody's, so nobody can answer for it).
   */
  const personOf = (sessionId: string): string | undefined =>
    sessionId.includes(':agent:')
      ? personOfSession(deps.tasks.get(sessionId)?.parentSessionId)
      : personOfSession(sessionId)
  const peekOf = (sessionId: string): HarnessAgent | undefined =>
    isFront(sessionId) ? deps.lead() : workerOf(sessionId)
  /** The pending approval `attentionId` of a session, when it can be read. */
  const approvalOf = async (sessionId: string, attentionId: string) => {
    try {
      const pending = await peekOf(sessionId)?.peek(sessionId)?.pending()
      return pending?.approvals.find((a) => a.approvalId === attentionId)
    } catch {
      return undefined
    }
  }
  /** `ageMs` and `expiresAt` of an approval item (epoch ms), when the lifetime and the age are known. */
  const lifeOf = (item: {
    createdAt: number | null
    sessionId: string
    toolCallId?: string
  }): { ageMs?: number; expiresAt?: number } => {
    if (deps.approvals === undefined || item.createdAt === null) return {}
    const conversation =
      deps.conversationTtlMs !== undefined &&
      item.toolCallId !== undefined &&
      deps.consent?.tierOf(item.sessionId, item.toolCallId) === 'conversation'
    return {
      ageMs: Math.max(0, Date.now() - item.createdAt),
      expiresAt:
        item.createdAt +
        (conversation ? (deps.conversationTtlMs?.() ?? 0) : deps.approvals.ttlMs()),
    }
  }
  /**
   * The `consent` field of an approval item (ADR-0036 §4): how the call is confirmed. A call whose tier is unknown (a restart, a
   * rule that is not the consent table) and an item the owner answers for a member are `device`. Nothing without the registry.
   */
  const consentOf = (
    item: { sessionId: string; toolCallId?: string },
    routed: boolean,
  ): { consent?: ConsentTier } => {
    if (deps.consent === undefined) return {}
    const tier =
      routed || item.toolCallId === undefined
        ? undefined
        : deps.consent.tierOf(item.sessionId, item.toolCallId)
    return { consent: tier ?? 'device' }
  }
  const roleOf = async (personId: string): Promise<string | undefined> =>
    deps.people.get(personId).then(
      (p) => p.role,
      () => undefined,
    )

  return {
    roots: async ({ principal }) => {
      const own = frontSessionId(principal.personId, deps.generations.current(principal.personId))
      if (principal.role !== 'owner') return [own]
      const others = peopleFor('route', await deps.people.list())
        .filter((p) => p.id !== principal.personId)
        .map((p) => frontSessionId(p.id, deps.generations.current(p.id)))
      return [own, ...others]
    },
    peek: (sessionId, info) => {
      const agent =
        info.parentSessionId === null && isFront(sessionId)
          ? deps.lead()
          : workerOf(sessionId, info.agent)
      return agent?.peek(sessionId)
    },
    open: (sessionId) => openQueueSession(deps, sessionId),
    // A person answers for their own sessions, except an item the owner answers (a member's
    // `shell.exec`); the owner answers exactly those items in other people's sessions. Answering one
    // from a remote client needs a step-up. A session that is not theirs is a 404.
    canAnswer: async ({ principal, sessionId, attentionId }) => {
      const owner = principal.role === 'owner'
      const mine = personOf(sessionId) === principal.personId
      if (!mine && !owner) return false
      const item = await approvalOf(sessionId, attentionId)
      const routed = item !== undefined && owned(item.toolName, item.input)
      if (!mine && !routed) return false
      if (!routed) {
        // a persona or model-switch approval (ADR-0034 §3, §8): the person answers their own, but a remote
        // client that has not stepped up gets the step-up denial, like every persona change (ADR-0029 §2)
        if (item !== undefined && STEP_UP_TOOLS.includes(item.toolName)) {
          const denied = stepUpDenial(principal)
          if (denied !== undefined) return { deny: 403, ...denied }
        }
        return true
      }
      if (!owner) {
        return {
          deny: 403,
          code: WAITING_FOR_OWNER,
          message: 'this waits for the owner to approve it',
        }
      }
      const denied = stepUpDenial(principal)
      return denied === undefined ? true : { deny: 403, ...denied }
    },
    // The owner's answer for a member's session never sets a session grant: the next command of
    // the member must ask again.
    parseAnswer: async ({ item, defaultParse }) => {
      const effective = await effectiveAnswer(defaultParse(), item, roleOf, personOf, owned)
      if (item !== undefined && effective.kind === 'approval') {
        applied.set(trailKey(item.sessionId, item.id), effective.remember ?? 'once')
        if (applied.size > MAX_APPLIED) applied.delete(applied.keys().next().value as string)
      }
      return effective
    },
    describeApproval: async (sessionId, attentionId) => {
      const item = await approvalOf(sessionId, attentionId)
      if (item === undefined) return undefined
      const call = motorAskOf(item.toolName, item.input)
      if (call === undefined) return undefined
      return {
        node: call.node,
        capability: call.capability,
        driver: driverOf(call.capability),
        ...(call.command === undefined
          ? {}
          : { command: redactString(call.command).slice(0, APPROVAL_COMMAND_MAX) }),
      }
    },
    appliedRemember: (sessionId, attentionId) => applied.get(trailKey(sessionId, attentionId)),
    decorate: async (item, { principal }) => {
      if (item.kind !== 'approval')
        return personOf(item.sessionId) === principal.personId ? undefined : null
      const person = personOf(item.sessionId)
      const routed = owned(item.toolName, item.input)
      // the read side of the lifetime: how old the request is and when the sweeper denies it (ADR-0027 §10)
      const life = lifeOf(item)
      if (person !== principal.personId) {
        // someone else's session: the owner sees only what waits for them, with who asked. Such an answer
        // never sets a grant, so the TUI offers no "allow for task" (`scopable`, ADR-0027 §14)
        if (principal.role !== 'owner' || !routed || person === undefined) return null
        const asker = await deps.people.get(person).catch(() => undefined)
        return {
          askedBy: asker?.username ?? person,
          askedByName: asker?.name ?? person,
          ...ask(item),
          ...life,
          ...consentOf(item, true),
          scopable: false,
        }
      }
      if (routed && principal.role !== 'owner')
        return { waitingFor: 'owner', ...life, ...consentOf(item, true), scopable: false }
      return { ...life, ...consentOf(item, false), scopable: true }
    },
    allowRemember: true,
    store: deps.store,
    agentId: (sessionId) => (isFront(sessionId) ? 'front' : deps.tasks.get(sessionId)?.agent),
  }
}

/** Kept per core: the remember scope of answered approvals, until the audit reads it. */
const MAX_APPLIED = 500

/**
 * The answer that is applied. A member's `session` grant is dropped (the next command asks again), the owner's
 * answer for a member's session never sets one. Pure over the item and the answer.
 */
async function effectiveAnswer(
  answer: AttentionAnswer,
  item: { sessionId: string; toolName: string; input: unknown } | undefined,
  roleOf: (personId: string) => Promise<string | undefined>,
  personOf: (sessionId: string) => string | undefined,
  owned: (toolName: string, input: unknown) => boolean,
): Promise<AttentionAnswer> {
  if (
    answer.kind !== 'approval' ||
    answer.remember !== 'session' ||
    item === undefined ||
    !owned(item.toolName, item.input)
  )
    return answer
  const person = personOf(item.sessionId)
  if (person !== undefined && (await roleOf(person)) === 'owner') return answer
  const { remember: _dropped, ...once } = answer
  return once
}

/** The machine, capability and command of an item, for the owner to read before answering. */
function ask(item: { toolName: string; input: unknown }): Record<string, string> {
  const call = motorAskOf(item.toolName, item.input)
  return call === undefined ? {} : { ...call }
}
