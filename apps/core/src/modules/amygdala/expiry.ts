import type { PersonStatus } from '@keith/contracts'
import { type ActivityStore, answerAttention, listAttention } from 'eharness/activity'
import { type FrontGenerationOf, frontSessionId, peopleFor } from '../../platform/sessions.ts'
import type { Audit } from '../audit/index.ts'
import { emit } from '../brain-events/index.ts'
import { motorAskOf } from '../motor/index.ts'
import type { AttentionOptions } from './attention.ts'
import type { ConsentRegistry } from './consent.ts'
import { NO_ANSWER_IN_CONVERSATION } from './consent-conversation.ts'
import type { ApprovalSettings } from './settings.ts'

const HOUR_MS = 3_600_000
/** The `open` of `answerAttention`: the live session that owns an item. */
type OpenSession = Parameters<typeof answerAttention>[1]['open']

/** What the sweeper needs: the attention queue (`attentionOptions`), the setting, the feed and the audit log. */
export interface ApprovalExpiryDeps {
  /** Every person the core has (any status); the sweep walks the front session of those `recover` counts. */
  people(): Promise<readonly { id: string; status: PersonStatus }[]>
  peek: AttentionOptions['peek']
  /** The live session that owns an item, for writing (`openQueueSession`). */
  open: OpenSession
  approvals: Pick<ApprovalSettings, 'ttlHours' | 'ttlMs'>
  store: ActivityStore
  audit: Pick<Audit, 'record'>
  now?: () => number
  warn?: (message: string) => void
  /** How long a continuation may fail fast before the answer counts as given (ms); tests shorten it. */
  settleMs?: number
  /** The current front generation of each person (ADR-0030 §2): the session a person's events go to. */
  generations: FrontGenerationOf
  /** How each waiting call is confirmed (ADR-0036): a request asked in conversation lives `conversationTtlMs`, not `approvals`. */
  consent?: Pick<ConsentRegistry, 'tierOf'>
  /** The lifetime of a request asked in conversation (ms); absent: such a request keeps the approval lifetime. */
  conversationTtlMs?: () => number
}

/** The reason the agent reads when its request expired (the model tells the person to ask again). */
export const expiredReason = (hours: number): string =>
  `this request expired after ${hours} hours; ask again if it is still needed`

/**
 * Deny every pending approval older than `approvals.ttlHours` (ADR-0027 §10). The item is answered
 * through `answerAttention`, the same path the TUI takes, with `approved: false` and reason
 * `expired`: the parked tool call answers denied and its worker resumes with that text. Each denial
 * writes `approval.expired` (no command text) and `brain.amygdala.expired`. An item without a
 * readable age (no UUIDv7 message id) is left alone. Returns how many were denied.
 */
export async function expireApprovals(deps: ApprovalExpiryDeps): Promise<number> {
  const now = (deps.now ?? Date.now)()
  const ttl = deps.approvals.ttlMs()
  const hours = deps.approvals.ttlHours()
  // `recover` counts: active and suspended people keep their approvals expiring; a left person does not (ADR-0027 §15)
  const roots = peopleFor('recover', await deps.people()).map((p) =>
    frontSessionId(p.id, deps.generations.current(p.id)),
  )
  const items = await listAttention({
    roots,
    peek: deps.peek,
    waits: false,
  })
  let denied = 0
  for (const item of items) {
    if (item.kind !== 'approval' || item.createdAt === null) continue
    const age = now - item.createdAt
    const conversation =
      deps.conversationTtlMs !== undefined &&
      deps.consent?.tierOf(item.sessionId, item.toolCallId) === 'conversation'
    if (age < (conversation ? (deps.conversationTtlMs?.() ?? ttl) : ttl)) continue
    try {
      const peek = await deps.peek(item.sessionId, {
        ...(item.agent === undefined ? {} : { agent: item.agent }),
        parentSessionId: item.parentSessionId,
      })
      if (peek === undefined) continue
      const result = await answerAttention(item.id, {
        sessionId: item.sessionId,
        answer: {
          kind: 'approval',
          approved: false,
          reason: conversation ? NO_ANSWER_IN_CONVERSATION : expiredReason(hours),
        },
        open: deps.open,
        peek: () => peek,
        store: deps.store,
        agentId: item.agent ?? 'front',
        ...(deps.settleMs === undefined ? {} : { settleMs: deps.settleMs }),
        log: { warn: (message) => deps.warn?.(message) },
      })
      if (result.status !== 'resumed' && result.status !== 'recorded') continue
      denied += 1
      const call = motorAskOf(item.toolName, item.input)
      if (conversation)
        deps.audit.record({
          kind: 'consent.answered',
          actor: 'system',
          via: 'local',
          detail: {
            answer: 'expired',
            tier: 'conversation',
            tool: item.toolName,
            session: item.sessionId,
            callId: item.toolCallId,
          },
        })
      else
        deps.audit.record({
          kind: 'approval.expired',
          actor: 'system',
          via: 'local',
          detail: {
            sessionId: item.sessionId,
            approvalId: item.id,
            ageHours: Math.round(age / HOUR_MS),
            capability: call?.capability ?? item.toolName,
          },
        })
      emit(
        deps.store,
        'brain.amygdala.expired',
        item.sessionId,
        item.agent ?? null,
        { region: 'amygdala', sessionId: item.sessionId, approvalId: item.id },
        deps.warn,
      )
    } catch (error) {
      deps.warn?.(
        `approvals: expiring ${item.id} failed: ${error instanceof Error ? error.message : error}`,
      )
    }
  }
  return denied
}
