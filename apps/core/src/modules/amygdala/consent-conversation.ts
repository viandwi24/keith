// The person's next message answers a request asked in conversation (ADR-0036 §4, docs/specs/amygdala.md "Asked in conversation").
// It runs where a chat message of the person reaches their front session (thalamus `chat.validate`), before eharness applies
// `onNewInput` to the pending approvals. Only the person's own authenticated message is read, never a page, a report or a room.
import type { LanguageModel } from 'ai'
import type { ActivityStore } from 'eharness/activity'
import { type AttentionItem, answerAttention, listAttention } from 'eharness/activity'
import { type FrontGenerationOf, frontSessionId, principalOf } from '../../platform/sessions.ts'
import { type Audit, auditAnswer } from '../audit/index.ts'
import { type Principal, stepUpDenial, type Via } from '../auth/index.ts'
import type { AttentionOptions } from './attention.ts'
import type { ClientAuth } from './client-auth.ts'
import type { ConsentRegistry } from './consent.ts'
import { type ConsentAnswer, classifyConsent, classifyShort } from './consent-classifier.ts'
import { consentNoteText } from './consent-note.ts'
import { approvalSummary } from './consent-summary.ts'

/** The reason a worker or a front call reads when the person said no. */
export const SAID_NO = 'the person said no'
/** The reason when the person went on to something else. */
export const MOVED_ON = 'the person moved on'
/** The reason when the request outlived its lifetime (the sweeper, `expiry.ts`). */
export const NO_ANSWER_IN_CONVERSATION = 'no answer in the conversation'

export interface ConsentConversationDeps {
  /** The attention routes of the core: who may answer, the live sessions, the description of an approval. */
  attention: Pick<
    AttentionOptions,
    'peek' | 'open' | 'canAnswer' | 'describeApproval' | 'appliedRemember'
  >
  /** How each waiting call is confirmed: only `conversation` is answered here. */
  registry: Pick<ConsentRegistry, 'tierOf'>
  generations: FrontGenerationOf
  store: ActivityStore
  audit: Audit
  /** The client of each person's newest message (step-up of the persona tools). */
  clients: ClientAuth
  /**
   * Sends the person's message to their front session as an ordinary input carrying `note` for the model, queued when a turn
   * holds the session (eharness `ifBusy: 'queue'`, spec 11 §6.2). Rejects when the input was refused. Without it a worker's
   * answer is forwarded by the chat route (409 when the session is busy).
   */
  forward?: (call: { personId: string; text: string; note: string }) => Promise<void>
  /** The lifetime of a request asked in conversation (ms). */
  ttlMs: () => number
  /** The small model of the classifier (`consent-classifier.ts`). */
  model?: (personId: string) => Promise<LanguageModel | undefined>
  now?: () => number
  warn?: (message: string) => void
  /** How long a continuation may fail fast before the answer counts as given (ms); tests shorten it. */
  settleMs?: number
}

/** What the chat route does with the message after this ran. */
export type ConsentOutcome =
  /** Forward the message as a normal chat turn. */
  | { kind: 'forward' }
  /** The message was handled here (the answer, and for a worker's request the forward to the front session): answer the route with this response (`202`). */
  | { kind: 'answered'; response: Response }

export interface ConsentConversation {
  /**
   * The person's message in their own front chat. Records the client's step-up, then, when a request asked in conversation waits,
   * classifies the message and answers the request. Never throws: any failure forwards the message unchanged.
   */
  message(call: {
    principal: Principal
    via: Via
    text: string
    request: Request
  }): Promise<ConsentOutcome>
}

const FORWARD: ConsentOutcome = { kind: 'forward' }

export function createConsentConversation(deps: ConsentConversationDeps): ConsentConversation {
  const now = deps.now ?? Date.now
  const warn = (message: string) => deps.warn?.(message)

  /** The newest request asked in conversation of the person's chat (front or workers), not expired, or undefined. */
  async function newestRequest(personId: string): Promise<AttentionItem | undefined> {
    const root = frontSessionId(personId, deps.generations.current(personId))
    const items = await listAttention({ roots: [root], peek: deps.attention.peek, waits: false })
    const ttl = deps.ttlMs()
    return items
      .filter(
        (item) =>
          item.kind === 'approval' &&
          item.createdAt !== null &&
          now() - item.createdAt < ttl &&
          deps.registry.tierOf(item.sessionId, item.toolCallId) === 'conversation',
      )
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0]
  }

  const record = (answer: ConsentAnswer, item: AttentionItem, personId: string, via: Via): void =>
    deps.audit.record({
      kind: 'consent.answered',
      actor: personId,
      via,
      detail: {
        answer,
        tier: 'conversation',
        tool: item.toolName,
        session: item.sessionId,
        callId: item.toolCallId,
      },
    })

  async function answerOf(
    item: AttentionItem,
    answer: { approved: boolean; reason?: string; note?: string },
    personId: string,
    call: { principal: Principal; request: Request },
    quick = false,
  ): Promise<string | undefined> {
    const peek = await deps.attention.peek(item.sessionId, {
      ...(item.agent === undefined ? {} : { agent: item.agent }),
      parentSessionId: item.parentSessionId,
    })
    if (peek === undefined) return undefined
    const result = await answerAttention(item.id, {
      sessionId: item.sessionId,
      answer: {
        kind: 'approval',
        approved: answer.approved,
        ...(answer.reason === undefined ? {} : { reason: answer.reason }),
        ...(answer.note === undefined ? {} : { note: answer.note }),
        ...(answer.approved ? { remember: 'once' as const } : {}),
      },
      open: (id) => deps.attention.open(id, call),
      peek: () => peek,
      actor: principalOf(personId),
      store: deps.store,
      agentId: item.agent ?? 'front',
      // a message that goes on to the front agent must reach it before the worker's report wakes it: no waiting for the run
      ...(quick ? { settleMs: 1 } : deps.settleMs === undefined ? {} : { settleMs: deps.settleMs }),
      log: { warn },
    })
    return result.status === 'resumed' || result.status === 'recorded' ? result.status : undefined
  }

  return {
    async message({ principal, via, text, request }) {
      try {
        // the client of this message: a step-up tool runs on the person's word only from a client that stepped up
        deps.clients.note(principal.personId, stepUpDenial(principal, via) === undefined)
        if (text.trim() === '') return FORWARD
        const item = await newestRequest(principal.personId)
        if (item === undefined) return FORWARD
        // the same rules as the answer route: whose session it is, the owner's own queue, the step-up of persona and shell
        const allowed = await deps.attention.canAnswer?.({
          principal,
          request,
          sessionId: item.sessionId,
          attentionId: item.id,
        })
        if (allowed !== undefined && allowed !== true) return FORWARD
        const summary = approvalSummary(item.toolName, item.input)
        const model = deps.model
        const answer = await classifyConsent(text, summary, {
          ...(model === undefined ? {} : { model: () => model(principal.personId) }),
        })
        const inFront = item.parentSessionId === null
        // a bare yes or no (the fixed list) is the whole message; anything longer carries more the front agent should read
        const bare = classifyShort(text) !== undefined
        if (answer === 'other') {
          // a worker is waiting on its own session and nobody else will answer it; the front agent's own call is denied by
          // eharness when the message is sent (`onNewInput`), with the new message after it
          if (!inFront)
            await answerOf(
              item,
              { approved: false, reason: MOVED_ON },
              principal.personId,
              { principal, request },
              true,
            )
          record('other', item, principal.personId, via)
          return FORWARD
        }
        const approved = answer === 'yes'
        // the person's words go to the front agent's own call as its approval note (stored in the chat, a bare yes included); a
        // worker's request is answered and the message goes on to the front session with a note for the model
        // read before the answer runs: once it is answered the approval no longer waits
        const approval = await deps.attention
          .describeApproval(item.sessionId, item.id)
          .catch(() => undefined)
        const status = await answerOf(
          item,
          {
            approved,
            ...(approved ? {} : { reason: SAID_NO }),
            ...(inFront ? { note: text.slice(0, 4000) } : {}),
          },
          principal.personId,
          { principal, request },
          !inFront,
        )
        if (status === undefined) return FORWARD
        record(answer, item, principal.personId, via)
        await auditAnswer(deps.audit, {
          pending: {
            attentionId: item.id,
            sessionId: item.sessionId,
            answer: { kind: 'approval', approved },
            ...(approval === undefined ? {} : { approval }),
          },
          response: Response.json({ status }),
          principal,
          via,
          forwarded: false,
          trail: { appliedRemember: () => (approved ? 'once' : undefined) },
        })
        if (!inFront && deps.forward !== undefined) {
          try {
            await deps.forward({
              personId: principal.personId,
              text,
              note: consentNoteText(summary, answer),
            })
          } catch (error) {
            // the answer is given; the chat route sends the message on its own
            warn(
              `consent: forwarding the answer failed: ${error instanceof Error ? error.message : error}`,
            )
            return FORWARD
          }
        } else if (!inFront && !bare) return FORWARD
        return {
          kind: 'answered',
          response: Response.json(
            {
              inboxId: item.id,
              delivered: inFront ? 'steer' : 'queue',
              target: 'local',
              consent: answer,
            },
            { status: 202 },
          ),
        }
      } catch (error) {
        warn(`consent: ${error instanceof Error ? error.message : error}`)
        return FORWARD
      }
    },
  }
}
