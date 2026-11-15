import { approvalsOf, isWaitingForOwner, newInboxIds, routeOf } from '@keith/app-model'
import type { AttentionItem, KeithAttention } from '@keith/client/browser'
import { appBase, getClient } from '../session/index.ts'
import { stepUp } from '../stepup/index.ts'
import { toasts } from '../toasts/index.ts'
import { answerFailure, isStepUpCancelled, newlyExpired } from './card.ts'
import { inboxToast } from './consent-line.ts'

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * The person's pending approvals (`client.attention()`, already attached to the activity feed, so events and
 * resyncs refetch it). Oldest first. Answers go through the step-up guard: a remote client may be asked for
 * its PIN or password once, then the answer is sent again.
 */
class ApprovalsState {
  /** Pending approvals, oldest first (a member's owner-routed items included). */
  items = $state<AttentionItem[]>([])
  loaded = $state(false)
  /** The last refresh failed. */
  loadError = $state<string | undefined>(undefined)
  /** The clock of the cards (epoch ms), ticking each second while started. */
  now = $state(Date.now())
  /** Approvals this person can answer. */
  answerable = $derived(this.items.filter((i) => !isWaitingForOwner(i)))
  /** The cards that stay in the chat: an old core's items (no `extra.consent`). */
  legacy = $derived(this.items.filter((i) => routeOf(i) === 'legacy'))
  /** The ids of approvals being answered right now. */
  busy = $state<string[]>([])

  private list: KeithAttention | undefined
  private off: (() => void) | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private seenExpired = new Set<string>()
  private seenInbox = new Set<string>()

  start(): void {
    if (this.list !== undefined) return
    const list = getClient().attention()
    this.list = list
    this.read(list)
    this.off = list.subscribe(() => this.read(list))
    this.timer = setInterval(() => this.tick(), 1000)
    void list.refresh() // never rejects: a failure lands in the state's `error`
  }

  stop(): void {
    this.off?.()
    if (this.timer !== undefined) clearInterval(this.timer)
    this.off = undefined
    this.timer = undefined
    this.list = undefined
    this.items = []
    this.loaded = false
    this.seenExpired.clear()
    this.seenInbox.clear()
  }

  private read(list: KeithAttention): void {
    const state = list.get()
    this.items = approvalsOf(state.items)
    // a request for the Inbox (a device confirmation, another person's request) is announced once
    if (state.loaded && newInboxIds(this.items, this.seenInbox).length > 0) {
      const { text, link } = inboxToast(appBase())
      toasts.push(text, { level: 'info', link })
    }
    this.loaded = state.loaded
    this.loadError =
      state.error === null || state.error === undefined
        ? undefined
        : `Failed to load approvals: ${messageOf(state.error)}`
  }

  private tick(): void {
    this.now = Date.now()
    // the core denies an expired request at its next sweep: say so once while it is on screen
    if (newlyExpired(this.items, this.now, this.seenExpired).length > 0)
      toasts.push('request expired', { level: 'warning' })
  }

  approve = (item: AttentionItem): void => this.run(item, 'allowed', (l) => l.approve(item))
  deny = (item: AttentionItem, reason?: string): void =>
    this.run(item, 'denied', (l) => l.deny(item, reason))
  approveForTask = (item: AttentionItem): void =>
    this.run(item, 'allowed for the task', (l) => l.approveForSession(item))

  private run(
    item: AttentionItem,
    done: string,
    act: (list: KeithAttention) => Promise<unknown>,
  ): void {
    const list = this.list
    if (list === undefined || this.busy.includes(item.id)) return
    this.busy = [...this.busy, item.id]
    stepUp
      .guard(() => act(list))
      .then(
        () => toasts.push(done, { level: 'success' }),
        (error: unknown) =>
          isStepUpCancelled(error)
            ? toasts.push('Not confirmed.', { level: 'info' })
            : toasts.push(answerFailure(error), { level: 'error' }),
      )
      .finally(() => {
        this.busy = this.busy.filter((id) => id !== item.id)
      })
  }
}

export const approvals = new ApprovalsState()
