// The staged notice (docs/specs/dreaming.md "Notify"; ADR-0031 §5): a `propose` run that staged its plan tells the person once, through
// the delivery service. The text carries counts and the command `/dream apply`, never the text of a candidate or an entry. The
// delivery id is the run's day and a fingerprint of the plan's shape (its actions and targets, no text), so delivery's stored-id
// rule (`delivery.md`: a stored id sends nothing) makes a second run on the same day with an identical plan send nothing more.
import type { DeliveryRequestInput, DreamPlan, DreamRunCounts } from '@keith/contracts'

/** The source of the notice's delivery (the budget notice uses the same). */
export const DREAM_NOTICE_SOURCE = 'dreaming'
/** The event name the model sees for a notice (`eh.event`). */
export const DREAM_NOTICE_NAME = 'dreaming.notice'

/** What a staged run tells the person: the run's counts, the command, nothing else. */
export interface StagedNotice {
  personId: string
  /** The run's day (`YYYY-MM-DD`): one notice per person, per day and per plan shape. */
  day: string
  runId: string
  plan: DreamPlan
  counts: DreamRunCounts
}

/**
 * The fingerprint of a plan's shape: the sorted `action|target` pairs, hashed. The text of a candidate is not part of it, so two
 * plans with the same actions on the same targets are the same plan here, and nothing of the text reaches the delivery id.
 */
export function planFingerprint(plan: DreamPlan): string {
  const shape = plan.candidates
    .map((c) => `${c.action}|${c.target}`)
    .sort()
    .join('\n')
  return new Bun.CryptoHasher('sha256').update(shape).digest('hex').slice(0, 16)
}

/** The text of the notice: counts and the command (ADR-0031 §8: counts only). Fixed English, like the budget notice. */
export function stagedNoticeText(counts: DreamRunCounts): string {
  const changes = counts.promoted + counts.merged + counts.superseded
  return `Memory review ready: ${counts.candidates} new notes checked, ${changes} changes waiting (${counts.promoted} to promote, ${counts.merged} to merge, ${counts.superseded} to supersede, ${counts.dropped} dropped). Nothing in your memory has changed yet. Run /dream apply to write them.`
}

/** The delivery request of a staged run: a stored note (no turn, no cost), the id keyed by the day and the plan's shape. */
export function stagedNoticeRequest(notice: StagedNotice): DeliveryRequestInput {
  return {
    id: `dream-staged:${notice.personId}:${notice.day}:${planFingerprint(notice.plan)}`,
    source: DREAM_NOTICE_SOURCE,
    to: notice.personId,
    name: DREAM_NOTICE_NAME,
    text: stagedNoticeText(notice.counts),
    needs: { mode: 'note', capabilities: [], fanout: 'best', urgency: 'normal' },
  }
}

/**
 * Sends the staged notice through the delivery service. Never throws: a failed delivery is warned, and the staged plan stays
 * where it is (the person can still run `/dream apply`). Absent `deliver`, nothing is sent.
 */
export async function sendStagedNotice(
  deliver: ((request: DeliveryRequestInput) => Promise<unknown>) | undefined,
  notice: StagedNotice,
  warn: (message: string) => void,
): Promise<void> {
  if (deliver === undefined) return
  try {
    await deliver(stagedNoticeRequest(notice))
  } catch (error) {
    warn(`dreaming: staged notice not sent: ${error instanceof Error ? error.message : error}`)
  }
}
