import type { SuccessionHeirView, SuccessionOwnerView, SuccessionState } from '@keith/contracts'
import { clock } from './protocols-state.ts'

export const DAY_MS = 86_400_000
/** The word the heir types to confirm the claim (the typed confirmation, succession.md "The claim"). */
export const CLAIM_WORD = 'claim'

/** The state as the owner reads it: the same words as the contract. */
export const stateWord = (state: SuccessionState): string => state

/** `today`, `1 day ago`, `N days ago` or `never`: the owner's last sign, in days. */
export function signAgeOf(lastSignAt: number | null, now: number): string {
  if (lastSignAt === null) return 'never'
  const days = Math.max(0, Math.floor((now - lastSignAt) / DAY_MS))
  if (days === 0) return 'today'
  return days === 1 ? '1 day ago' : `${days} days ago`
}

/** The state with its date when the run has one: `grace since 11-03 09:00`. */
export function stateDetail(view: SuccessionOwnerView): string {
  const since = (ms: number | null): string | undefined => (ms === null ? undefined : clock(ms))
  const at =
    view.state === 'claimable'
      ? since(view.claimableAt)
      : view.state === 'grace'
        ? since(view.graceStartedAt)
        : view.state === 'check-in'
          ? since(view.startedAt)
          : undefined
  return at === undefined ? stateWord(view.state) : `${stateWord(view.state)} since ${at}`
}

/** The owner's view: label and value rows, the labels in one column. */
export function ownerLines(view: SuccessionOwnerView, now: number): string[] {
  const paused = view.pausedUntil !== null && view.pausedUntil > now
  const rows: [string, string][] = [
    ['heir', view.heir === null ? 'none: the protocol is off until you name one' : view.heir.name],
    ['window', `${view.windowDays} days`],
    ['state', stateDetail(view)],
    ['pause', paused ? `until ${clock(view.pausedUntil ?? now)}` : 'none'],
    ['last sign', signAgeOf(view.lastSignAt, now)],
  ]
  return rows.map(([label, value]) => `${label.padEnd(10)}${value}`)
}

/** The heir's view: the state in words, with the claim date when the core has one. */
export function heirLines(view: SuccessionHeirView): string[] {
  switch (view.state) {
    case 'grace':
      return [heirCaptionText(view) ?? '']
    case 'claimable':
      return ['Claim is open.']
    case 'check-in':
      return ['Keith is checking in with the owner.']
    case 'claimed':
      return ['This Keith is already claimed.']
    case 'idle':
      return ['No claim is open.']
  }
}

/** The one line the heir sees on Home while a claim is coming or open; `undefined` in every other state. */
export function heirCaptionText(view: SuccessionHeirView): string | undefined {
  if (view.state === 'grace')
    return view.claimOpensAt === null
      ? 'You can take over this Keith once the grace period ends'
      : `You can take over this Keith: the claim opens ${clock(view.claimOpensAt)}`
  if (view.state === 'claimable') return 'Claim is open'
  return undefined
}

/** The Home caption row for the heir (muted; the caption slot takes it under the orb). */
export function heirCaptionOf(
  view: SuccessionHeirView | undefined,
): { text: string; tone: 'muted' } | undefined {
  const text = view === undefined ? undefined : heirCaptionText(view)
  return text === undefined ? undefined : { text, tone: 'muted' }
}

/** The typed confirmation: the word, case and spaces aside. */
export const claimWordOk = (typed: string): boolean => typed.trim().toLowerCase() === CLAIM_WORD
