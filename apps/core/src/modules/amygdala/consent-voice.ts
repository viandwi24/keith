// A request asked in conversation, once it exists (ADR-0036 §4, docs/specs/amygdala.md "Asked in conversation"): the audit row
// `consent.asked`, and for a worker's request one wake to the person's front session asking the front agent to voice it. A
// front call needs none: the front agent says it itself before the call (`CONSENT_INSTRUCTIONS`).
import type { DeliveryRequestInput } from '@keith/contracts'
import { untrustedContent } from 'eharness'
import { personOfSession, rootSessionOf } from '../../platform/sessions.ts'
import type { Audit } from '../audit/index.ts'
import type { AttentionOptions } from './attention.ts'
import type { ConsentRegistry } from './consent.ts'
import { approvalSummary } from './consent-summary.ts'

/** The `eh.event` name of the wake the front agent reads. */
export const CONSENT_REQUEST_EVENT = 'consent.request'

/** A fresh approval seen on the activity feed (`watchPending`). */
export interface FreshApproval {
  sessionId: string
  approvalId: string
  toolName: string
  agentId: string | null
}

export interface ConsentVoiceDeps {
  attention: Pick<AttentionOptions, 'peek'>
  registry: Pick<ConsentRegistry, 'tierOf'>
  /** The delivery service: a worker's request reaches the front session like any other worker event. */
  delivery: { deliver(request: DeliveryRequestInput): Promise<unknown> }
  audit: Pick<Audit, 'record'>
  /** The lifetime of a request, for the line the front agent reads (ms). */
  ttlMs: () => number
  warn?: (message: string) => void
  /** Waits between two reads of a session that has not saved the approval yet (ms). */
  retryMs?: number
}

/** The text of the wake: the request in one line (framed: a worker wrote the command) and what the front agent must do. */
export function voiceText(summary: string, minutes: number): string {
  return [
    `A worker needs the person's yes before it runs this: ${untrustedContent(summary, { source: 'worker-request', name: CONSENT_REQUEST_EVENT })}`,
    'Voice the request to the person now, in one or two sentences: what it will do, where, and why (from the task you gave the worker), ending with exactly one yes/no question.',
    `Call no tool, never say it is done, and never answer the question yourself: the person's next message answers it. The request waits about ${minutes} minutes.`,
  ].join('\n')
}

export function createConsentVoice(
  deps: ConsentVoiceDeps,
): (fresh: FreshApproval) => Promise<void> {
  const warn = (message: string) => deps.warn?.(message)
  const retryMs = deps.retryMs ?? 40

  const find = async (fresh: FreshApproval) => {
    const worker = fresh.sessionId.includes(':agent:')
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const peek = await deps.attention.peek(fresh.sessionId, {
        ...(fresh.agentId === null ? {} : { agent: fresh.agentId }),
        parentSessionId: worker ? rootSessionOf(fresh.sessionId) : null,
      })
      const pending = await peek?.pending()
      const found = pending?.approvals.find((a) => a.approvalId === fresh.approvalId)
      if (found !== undefined) return found
      await new Promise((resolve) => setTimeout(resolve, retryMs))
    }
    return undefined
  }

  return async (fresh) => {
    try {
      const approval = await find(fresh)
      if (approval === undefined) return
      if (deps.registry.tierOf(fresh.sessionId, approval.toolCallId) !== 'conversation') return
      deps.audit.record({
        kind: 'consent.asked',
        actor: 'system',
        via: 'local',
        detail: {
          tier: 'conversation',
          tool: approval.toolName,
          session: fresh.sessionId,
          callId: approval.toolCallId,
        },
      })
      if (!fresh.sessionId.includes(':agent:')) return
      const person = personOfSession(fresh.sessionId)
      if (person === undefined) return
      await deps.delivery.deliver({
        id: `consent:${fresh.sessionId}:${fresh.approvalId}`.slice(0, 200),
        source: 'amygdala:consent',
        to: person,
        name: CONSENT_REQUEST_EVENT,
        text: voiceText(
          approvalSummary(approval.toolName, approval.input),
          Math.max(1, Math.round(deps.ttlMs() / 60_000)),
        ),
        needs: { mode: 'wake', capabilities: [], fanout: 'best', urgency: 'normal' },
      })
    } catch (error) {
      warn(`consent: voicing a request failed: ${error instanceof Error ? error.message : error}`)
    }
  }
}
