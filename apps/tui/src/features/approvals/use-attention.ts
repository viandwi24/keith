import type { AttentionItem, KeithClient } from '@keith/client'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { isWaitingForOwner, WAITING_TEXT } from '../stepup/index.ts'
import { approvalsOf, isWaitingForOwner as waitsForOwner } from './approval-state.ts'

export interface Approvals {
  /** Approvals waiting for this person, oldest first (a member's owner-routed items included). */
  items: readonly AttentionItem[]
  /** The items this person can answer (not `waitingFor: 'owner'`), oldest first. */
  answerable: readonly AttentionItem[]
  /** The last answer or refresh failed (shown as a toast). */
  error: string | undefined
  clearError(): void
  approve(item: AttentionItem): void
  deny(item: AttentionItem, reason?: string): void
  approveForSession(item: AttentionItem): void
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * The owner's approvals: `client.attention()` (already attached to the feed, so events and
 * resyncs refetch it), read at mount. Answers are optimistic; a failure becomes `error`.
 */
export function useApprovals(
  client: KeithClient,
  guard: <T>(act: () => Promise<T>) => Promise<T> = (act) => act(),
): Approvals {
  const list = client.attention()
  const state = useSyncExternalStore(
    (run) => list.subscribe(() => run()),
    () => list.get(),
  )
  const [answerError, setError] = useState<string | undefined>()
  useEffect(() => {
    void list.refresh() // never rejects: a failure lands in `state.error`
  }, [list])
  const error =
    answerError ??
    (state.error === null ? undefined : `Failed to load approvals: ${messageOf(state.error)}`)
  const items = useMemo(() => approvalsOf(state.items), [state.items])
  const answerable = useMemo(() => items.filter((i) => !waitsForOwner(i)), [items])
  // an answer the core refuses for a step-up is asked again once after the PIN prompt
  const run = useCallback(
    (act: () => Promise<unknown>) => {
      setError(undefined)
      guard(act).catch((e: unknown) =>
        setError(isWaitingForOwner(e) ? WAITING_TEXT : `Failed to answer: ${messageOf(e)}`),
      )
    },
    [guard],
  )
  return {
    items,
    answerable,
    error,
    clearError: useCallback(() => setError(undefined), []),
    approve: (item) => run(() => list.approve(item)),
    deny: (item, reason) => run(() => list.deny(item, reason)),
    approveForSession: (item) => run(() => list.approveForSession(item)),
  }
}
