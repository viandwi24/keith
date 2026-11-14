import type { AuditVia } from '@keith/db'
import type { ApprovalDescription, AttentionTrail } from '../amygdala/index.ts'
import type { Audit } from './audit.ts'

/**
 * An answer to an attention item (`POST /attention/:id/answer`) as it arrives, before the core runs it: the
 * approval is read now, while it still waits (the node, capability and command it asks for).
 */
export interface PendingAnswer {
  attentionId: string
  sessionId: string | null
  /** The answer as the owner sent it (the requested remember scope is in here; the applied one is not). */
  answer: Record<string, unknown>
  approval?: ApprovalDescription
}

/** The part of the attention trail the answer audit reads. */
export type AnswerTrail = Partial<Pick<AttentionTrail, 'describeApproval' | 'appliedRemember'>>

/**
 * Reads an answer before it is run. Returns undefined for any other route, a body that is not an answer, or
 * a POST that the audit does not cover. Never throws.
 */
export async function readAnswer(
  request: Request,
  trail?: AnswerTrail,
): Promise<PendingAnswer | undefined> {
  try {
    const url = new URL(request.url)
    const match = /^\/attention\/([^/]+)\/answer$/.exec(url.pathname)
    if (match === null || request.method !== 'POST') return undefined
    const body = (await request.json()) as { sessionId?: unknown; answer?: Record<string, unknown> }
    const attentionId = decodeURIComponent(match[1] as string)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null
    const approval =
      sessionId === null ? undefined : await trail?.describeApproval?.(sessionId, attentionId)
    return {
      attentionId,
      sessionId,
      answer: body.answer ?? {},
      ...(approval === undefined ? {} : { approval }),
    }
  } catch {
    return undefined
  }
}

/**
 * Record an answer after the core accepted it: who, over which listener, the decision, and for an approval
 * the node, capability and command it was about and the remember scope that was applied (not the one asked
 * for: a member's `session` grant is dropped). Never throws and never records free text (reasons, notes).
 */
export async function auditAnswer(
  audit: Audit,
  call: {
    pending: PendingAnswer | undefined
    response: Response
    principal: { personId: string } | undefined
    via: AuditVia
    forwarded: boolean
    trail?: AnswerTrail | undefined
  },
): Promise<void> {
  try {
    const pending = call.pending
    if (pending === undefined || !call.response.ok) return
    const { answer } = pending
    const result = (await call.response
      .clone()
      .json()
      .catch(() => ({}))) as { status?: unknown }
    const applied =
      answer.kind === 'approval' && pending.sessionId !== null
        ? call.trail?.appliedRemember?.(pending.sessionId, pending.attentionId)
        : undefined
    audit.record({
      kind: 'approval.answered',
      actor: call.principal?.personId ?? 'system',
      via: call.via,
      detail: {
        attentionId: pending.attentionId,
        sessionId: pending.sessionId,
        answerKind: answer.kind ?? null,
        ...(typeof answer.approved === 'boolean' ? { approved: answer.approved } : {}),
        ...(applied === undefined ? {} : { remember: applied }),
        ...(pending.approval === undefined
          ? {}
          : {
              node: pending.approval.node,
              capability: pending.approval.capability,
              ...(pending.approval.driver === undefined ? {} : { driver: pending.approval.driver }),
              ...(pending.approval.command === undefined
                ? {}
                : { command: pending.approval.command }),
            }),
        status: result.status ?? null,
        ...(call.forwarded ? { forwarded: true } : {}),
      },
    })
  } catch {
    // an audit failure never changes the answer the owner gave
  }
}
